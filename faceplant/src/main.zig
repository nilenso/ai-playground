const std = @import("std");
const c = @cImport({
    @cInclude("sqlite3.h");
});

const Allocator = std.mem.Allocator;

const reset_css = "*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:sans-serif;line-height:1.4;padding:16px}a{color:#06c}form{margin:0}.stack>*+*{margin-top:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.panel{border:1px solid #ccc;padding:12px;margin:12px 0}.muted{color:#666}.danger{color:#900}input,select,button,textarea{font:inherit;padding:6px}textarea{width:100%;min-height:120px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px;text-align:left}ul{padding-left:20px}.chart{height:260px}.logs{height:260px;overflow:auto;background:#f7f7f7;padding:8px;white-space:pre-wrap}";

const HttpStatus = enum(u16) {
    ok = 200,
    created = 201,
    found = 302,
    bad_request = 400,
    unauthorized = 401,
    forbidden = 403,
    not_found = 404,
    method_not_allowed = 405,
    internal_server_error = 500,
};

const Header = struct { name: []const u8, value: []const u8 };

const Request = struct {
    allocator: Allocator,
    method: []const u8,
    target: []const u8,
    path: []const u8,
    query: []const u8,
    headers: []Header,
    body: []const u8,

    fn header(self: Request, name: []const u8) ?[]const u8 {
        for (self.headers) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        }
        return null;
    }

    fn cookie(self: Request, name: []const u8) ?[]const u8 {
        const all = self.header("Cookie") orelse return null;
        var parts = std.mem.splitScalar(u8, all, ';');
        while (parts.next()) |p| {
            const trimmed = std.mem.trim(u8, p, " \t");
            const eq = std.mem.indexOfScalar(u8, trimmed, '=') orelse continue;
            if (std.mem.eql(u8, trimmed[0..eq], name)) return trimmed[eq + 1 ..];
        }
        return null;
    }
};

const Response = struct {
    status: HttpStatus = .ok,
    content_type: []const u8 = "text/html; charset=utf-8",
    headers: std.array_list.Managed(Header),
    body: std.array_list.Managed(u8),

    fn init(allocator: Allocator) Response {
        return .{ .headers = std.array_list.Managed(Header).init(allocator), .body = std.array_list.Managed(u8).init(allocator) };
    }

    fn deinit(self: *Response) void {
        self.headers.deinit();
        self.body.deinit();
    }

    fn setHeader(self: *Response, name: []const u8, value: []const u8) !void {
        try self.headers.append(.{ .name = name, .value = value });
    }

    fn write(self: *Response, text: []const u8) !void {
        try self.body.appendSlice(text);
    }

    fn writer(self: *Response) std.array_list.Managed(u8).Writer {
        return self.body.writer();
    }
};

const LabelMatcher = struct { key: []const u8, op: Op, value: []const u8 };
const Op = enum { eq, neq };
const SamplePoint = struct { ts_ms: i64, value: f64 };
const LogEntry = struct { ts_ms: i64, labels: []const u8, line: []const u8 };
const Series = struct {
    labels: []const u8,
    points: []SamplePoint,
};

const Selector = struct {
    name: []const u8,
    labels: []LabelMatcher,
    window_ms: ?i64 = null,
};

const PromExpr = union(enum) {
    selector: Selector,
    agg: struct { op: []const u8, expr: *PromExpr },
    range_fn: struct { op: []const u8, selector: Selector },
};

const LogQuery = union(enum) {
    lines: struct { selector: Selector, includes: [][]const u8, excludes: [][]const u8 },
    range_metric: struct { op: []const u8, selector: Selector, includes: [][]const u8, excludes: [][]const u8 },
};

const RuleInput = struct {
    name: []const u8,
    kind: []const u8,
    query: []const u8,
    op: []const u8,
    threshold: f64,
    every_seconds: i64,
};

const InternalLoggerKind = enum { stable, derived };

const App = struct {
    allocator: Allocator,
    db: *c.sqlite3,
    started_at_ms: i64,
    secret_mutex: std.Thread.Mutex = .{},
    runtime_secret: ?[]u8 = null,
    internal_log_mutex: std.Thread.Mutex = .{},
    derived_logs_enabled: bool = false,
    derived_tokens: f64 = 100,
    derived_capacity: f64 = 100,
    derived_refill_per_sec: f64 = 10,
    derived_last_refill_ms: i64 = 0,
    derived_dropped: u64 = 0,

    fn init(allocator: Allocator, data_dir: []const u8) !App {
        try std.fs.cwd().makePath(data_dir);
        const db_path = try std.fs.path.join(allocator, &.{ data_dir, "faceplant.sqlite" });
        defer allocator.free(db_path);

        var db_ptr: ?*c.sqlite3 = null;
        if (c.sqlite3_open(db_path.ptr, &db_ptr) != c.SQLITE_OK) return error.SqliteOpenFailed;
        const db = db_ptr orelse return error.SqliteOpenFailed;
        const start_ms = nowMs();
        const derived_logs_enabled = blk: {
            const raw = std.process.getEnvVarOwned(allocator, "FACEPLANT_DERIVED_LOGS") catch break :blk false;
            defer allocator.free(raw);
            break :blk std.mem.eql(u8, raw, "1") or std.ascii.eqlIgnoreCase(raw, "true");
        };
        var app = App{
            .allocator = allocator,
            .db = db,
            .started_at_ms = start_ms,
            .derived_logs_enabled = derived_logs_enabled,
            .derived_last_refill_ms = start_ms,
        };
        try app.exec(
            "PRAGMA journal_mode=WAL;"
            ++ "CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            ++ "CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);"
            ++ "CREATE TABLE IF NOT EXISTS dashboards(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);"
            ++ "CREATE TABLE IF NOT EXISTS panels(id INTEGER PRIMARY KEY AUTOINCREMENT, dashboard_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, query TEXT NOT NULL, x INTEGER NOT NULL DEFAULT 0, y INTEGER NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 12, h INTEGER NOT NULL DEFAULT 8);"
            ++ "CREATE TABLE IF NOT EXISTS scrape_targets(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, interval_seconds INTEGER NOT NULL DEFAULT 15);"
            ++ "CREATE TABLE IF NOT EXISTS metric_samples(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, labels TEXT NOT NULL, ts_ms INTEGER NOT NULL, value REAL NOT NULL);"
            ++ "CREATE INDEX IF NOT EXISTS idx_metric_samples_lookup ON metric_samples(name, ts_ms);"
            ++ "CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT, labels TEXT NOT NULL, ts_ms INTEGER NOT NULL, line TEXT NOT NULL);"
            ++ "CREATE INDEX IF NOT EXISTS idx_logs_lookup ON logs(ts_ms);"
            ++ "CREATE TABLE IF NOT EXISTS alert_rules(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, query TEXT NOT NULL, op TEXT NOT NULL, threshold REAL NOT NULL, every_seconds INTEGER NOT NULL DEFAULT 30);"
            ++ "CREATE TABLE IF NOT EXISTS alert_state(rule_id INTEGER PRIMARY KEY, state TEXT NOT NULL, value REAL NOT NULL, updated_at INTEGER NOT NULL);"
            ++ "CREATE TABLE IF NOT EXISTS alert_history(id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER NOT NULL, state TEXT NOT NULL, value REAL NOT NULL, changed_at INTEGER NOT NULL);",
        );

        if (std.process.getEnvVarOwned(allocator, "FACEPLANT_SECRET")) |env_secret| {
            app.runtime_secret = env_secret;
        } else |_| {
            if (try app.getConfig("instance_secret")) |s| {
                app.runtime_secret = try allocator.dupe(u8, s);
                allocator.free(s);
            }
        }
        return app;
    }

    fn deinit(self: *App) void {
        if (self.runtime_secret) |secret| self.allocator.free(secret);
        _ = c.sqlite3_close(self.db);
    }

    fn exec(self: *App, sql: []const u8) !void {
        var err: [*c]u8 = null;
        if (c.sqlite3_exec(self.db, sql.ptr, null, null, &err) != c.SQLITE_OK) {
            if (err) |e| {
                defer c.sqlite3_free(e);
                std.log.err("sqlite exec: {s}", .{std.mem.span(e)});
            }
            return error.SqliteExecFailed;
        }
    }

    fn prepare(self: *App, sql: []const u8) !*c.sqlite3_stmt {
        var stmt: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(self.db, sql.ptr, @intCast(sql.len), &stmt, null) != c.SQLITE_OK) return error.SqlitePrepareFailed;
        return stmt orelse return error.SqlitePrepareFailed;
    }

    fn bindText(stmt: *c.sqlite3_stmt, idx: c_int, text: []const u8) !void {
        if (c.sqlite3_bind_text(stmt, idx, text.ptr, @intCast(text.len), c.SQLITE_TRANSIENT) != c.SQLITE_OK) return error.SqliteBindFailed;
    }

    fn bindInt(stmt: *c.sqlite3_stmt, idx: c_int, value: i64) !void {
        if (c.sqlite3_bind_int64(stmt, idx, value) != c.SQLITE_OK) return error.SqliteBindFailed;
    }

    fn bindDouble(stmt: *c.sqlite3_stmt, idx: c_int, value: f64) !void {
        if (c.sqlite3_bind_double(stmt, idx, value) != c.SQLITE_OK) return error.SqliteBindFailed;
    }

    fn stepDone(stmt: *c.sqlite3_stmt) !void {
        const rc = c.sqlite3_step(stmt);
        if (rc != c.SQLITE_DONE) return error.SqliteStepFailed;
    }

    fn nowMs() i64 {
        return std.time.milliTimestamp();
    }

    fn getConfig(self: *App, key: []const u8) !?[]u8 {
        const stmt = try self.prepare("SELECT value FROM config WHERE key=?1");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, key);
        if (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const txt = c.sqlite3_column_text(stmt, 0);
            const len: usize = @intCast(c.sqlite3_column_bytes(stmt, 0));
            return try self.allocator.dupe(u8, txt[0..len]);
        }
        return null;
    }

    fn setConfig(self: *App, key: []const u8, value: []const u8) !void {
        const stmt = try self.prepare("INSERT INTO config(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, key);
        try bindText(stmt, 2, value);
        try stepDone(stmt);
    }

    fn ensureSecret(self: *App, attempted: []const u8) !void {
        self.secret_mutex.lock();
        defer self.secret_mutex.unlock();
        if (self.runtime_secret == null) {
            self.runtime_secret = try self.allocator.dupe(u8, attempted);
            try self.setConfig("instance_secret", attempted);
        }
    }

    fn checkSecret(self: *App, attempted: []const u8) bool {
        self.secret_mutex.lock();
        defer self.secret_mutex.unlock();
        const secret = self.runtime_secret orelse return false;
        return timingSafeEql(secret, attempted);
    }

    fn createSession(self: *App) ![]u8 {
        var buf: [48]u8 = undefined;
        var rand = std.Random.DefaultPrng.init(@as(u64, @truncate(@as(u128, @intCast(std.time.nanoTimestamp())))));
        _ = rand.random().bytes(&buf);
        const token = try self.allocator.dupe(u8, &std.fmt.bytesToHex(buf, .lower));
        const stmt = try self.prepare("INSERT INTO sessions(token, created_at) VALUES(?1, ?2)");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, token);
        try bindInt(stmt, 2, nowMs());
        try stepDone(stmt);
        return token;
    }

    fn sessionValid(self: *App, token: []const u8) !bool {
        const stmt = try self.prepare("SELECT 1 FROM sessions WHERE token=?1");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, token);
        return c.sqlite3_step(stmt) == c.SQLITE_ROW;
    }

    fn deleteSession(self: *App, token: []const u8) !void {
        const stmt = try self.prepare("DELETE FROM sessions WHERE token=?1");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, token);
        try stepDone(stmt);
    }

    fn emitStableLog(self: *App, component: []const u8, level: []const u8, line: []const u8) void {
        self.emitInternalLog(.stable, component, level, line) catch |err| {
            std.log.err("stable self-log failed: {}", .{err});
        };
        const dropped = self.takeDerivedDropped();
        if (dropped == 0 or std.mem.eql(u8, component, "internal_logger")) return;
        const summary = std.fmt.allocPrint(self.allocator, "derived logger dropped {d} event(s)", .{dropped}) catch return;
        defer self.allocator.free(summary);
        self.emitInternalLog(.stable, "internal_logger", "warn", summary) catch |err| {
            std.log.err("stable self-log summary failed: {}", .{err});
        };
    }

    fn emitDerivedLog(self: *App, component: []const u8, level: []const u8, line: []const u8) void {
        if (!self.allowDerivedLog()) return;
        self.emitInternalLog(.derived, component, level, line) catch |err| {
            std.log.err("derived self-log failed: {}", .{err});
        };
    }

    fn allowDerivedLog(self: *App) bool {
        self.internal_log_mutex.lock();
        defer self.internal_log_mutex.unlock();
        if (!self.derived_logs_enabled) return false;
        const now = nowMs();
        const elapsed_ms = now - self.derived_last_refill_ms;
        if (elapsed_ms > 0) {
            const refill = (@as(f64, @floatFromInt(elapsed_ms)) / 1000.0) * self.derived_refill_per_sec;
            self.derived_tokens = @min(self.derived_capacity, self.derived_tokens + refill);
            self.derived_last_refill_ms = now;
        }
        if (self.derived_tokens >= 1) {
            self.derived_tokens -= 1;
            return true;
        }
        self.derived_dropped += 1;
        return false;
    }

    fn takeDerivedDropped(self: *App) u64 {
        self.internal_log_mutex.lock();
        defer self.internal_log_mutex.unlock();
        const dropped = self.derived_dropped;
        self.derived_dropped = 0;
        return dropped;
    }

    fn emitInternalLog(self: *App, kind: InternalLoggerKind, component: []const u8, level: []const u8, line: []const u8) !void {
        const kind_text = switch (kind) {
            .stable => "stable",
            .derived => "derived",
        };
        const safe_component = try jsonEscapeAlloc(self.allocator, component);
        defer self.allocator.free(safe_component);
        const safe_level = try jsonEscapeAlloc(self.allocator, level);
        defer self.allocator.free(safe_level);
        const safe_line = try jsonEscapeAlloc(self.allocator, line);
        defer self.allocator.free(safe_line);
        const body = try std.fmt.allocPrint(
            self.allocator,
            "{{\"streams\":[{{\"labels\":{{\"app\":\"faceplant\",\"source\":\"self\",\"logger\":\"{s}\",\"component\":\"{s}\",\"level\":\"{s}\"}},\"entries\":[{{\"ts\":{d},\"line\":\"{s}\"}}]}}]}}",
            .{ kind_text, safe_component, safe_level, nowMs(), safe_line },
        );
        defer self.allocator.free(body);
        _ = try self.ingestLogPushPayload(body);
    }

    fn parseForm(self: *App, allocator: Allocator, body: []const u8) !std.StringHashMap([]u8) {
        _ = self;
        var map = std.StringHashMap([]u8).init(allocator);
        var it = std.mem.splitScalar(u8, body, '&');
        while (it.next()) |part| {
            if (part.len == 0) continue;
            const eq = std.mem.indexOfScalar(u8, part, '=') orelse part.len;
            const k = try urlDecodeAlloc(allocator, part[0..eq]);
            const v = if (eq < part.len) try urlDecodeAlloc(allocator, part[eq + 1 ..]) else try allocator.dupe(u8, "");
            try map.put(k, v);
        }
        return map;
    }

    fn requireAuth(self: *App, req: Request, res: *Response) !bool {
        const token = req.cookie("faceplant_session") orelse {
            res.status = .found;
            try res.setHeader("Location", "/login");
            return false;
        };
        if (!(try self.sessionValid(token))) {
            res.status = .found;
            try res.setHeader("Location", "/login");
            return false;
        }
        return true;
    }

    fn htmlPage(self: *App, res: *Response, title: []const u8, body: []const u8) !void {
        _ = self;
        var w = res.writer();
        const safe_title = try htmlEscapeAlloc(res.body.allocator, title);
        defer res.body.allocator.free(safe_title);
        try w.print("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{s}</title><link rel=\"stylesheet\" href=\"/reset.css\"></head><body>", .{safe_title});
        try w.writeAll("<nav class='row'><a href='/'>Dashboards</a><a href='/logs'>Logs</a><a href='/alerts'>Alerts</a><a href='/settings'>Settings</a><a href='/status'>Status</a><form method='post' action='/logout'><button type='submit'>Logout</button></form></nav><hr>");
        try w.writeAll(body);
        try w.writeAll("</body></html>");
    }

    fn renderLogin(self: *App, res: *Response, msg: []const u8) !void {
        const mode = if (self.runtime_secret == null) "Set or enter a secret for this running instance." else "Enter the shared secret.";
        const safe_mode = try htmlEscapeAlloc(self.allocator, mode);
        defer self.allocator.free(safe_mode);
        const safe_msg = try htmlEscapeAlloc(self.allocator, msg);
        defer self.allocator.free(safe_msg);
        const body = try std.fmt.allocPrint(self.allocator,
            "<div class='stack'><h1>Faceplant login</h1><p class='muted'>{s}</p><p class='danger'>{s}</p><form method='post' action='/login' class='stack'><input type='password' name='secret' placeholder='Secret'><button type='submit'>Login</button></form></div>",
            .{ safe_mode, safe_msg },
        );
        defer self.allocator.free(body);
        try self.htmlPage(res, "Login", body);
    }

    fn redirect(res: *Response, location: []const u8) !void {
        res.status = .found;
        try res.setHeader("Location", location);
    }

    fn dispatch(self: *App, req: Request) !Response {
        var res = Response.init(req.allocator);
        errdefer res.deinit();

        if (std.mem.eql(u8, req.path, "/reset.css")) {
            res.content_type = "text/css; charset=utf-8";
            try res.write(reset_css);
            return res;
        }

        if (std.mem.eql(u8, req.path, "/login") and std.mem.eql(u8, req.method, "GET")) {
            try self.renderLogin(&res, "");
            return res;
        }
        if (std.mem.eql(u8, req.path, "/login") and std.mem.eql(u8, req.method, "POST")) {
            var form = try self.parseForm(req.allocator, req.body);
            defer freeMap(req.allocator, &form);
            const secret = form.get("secret") orelse "";
            try self.ensureSecret(secret);
            if (!self.checkSecret(secret)) {
                self.emitStableLog("auth", "warn", "login failed");
                try self.renderLogin(&res, "Invalid secret");
                res.status = .unauthorized;
                return res;
            }
            self.emitStableLog("auth", "info", "login succeeded");
            const token = try self.createSession();
            defer self.allocator.free(token);
            const cookie = try std.fmt.allocPrint(req.allocator, "faceplant_session={s}; Path=/; HttpOnly; Secure; SameSite=Strict", .{token});
            try res.setHeader("Set-Cookie", cookie);
            try redirect(&res, "/");
            return res;
        }

        if (std.mem.eql(u8, req.path, "/logout") and std.mem.eql(u8, req.method, "POST")) {
            if (req.cookie("faceplant_session")) |token| {
                try self.deleteSession(token);
            }
            self.emitStableLog("auth", "info", "logout");
            try res.setHeader("Set-Cookie", "faceplant_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
            try redirect(&res, "/login");
            return res;
        }

        if (!(std.mem.eql(u8, req.path, "/login") or std.mem.eql(u8, req.path, "/api/logs/push") or std.mem.eql(u8, req.path, "/healthz"))) {
            if (!(try self.requireAuth(req, &res))) return res;
        }

        if (std.mem.eql(u8, req.path, "/healthz")) {
            res.content_type = "text/plain; charset=utf-8";
            try res.write("ok\n");
            return res;
        }

        if (std.mem.eql(u8, req.path, "/") and std.mem.eql(u8, req.method, "GET")) {
            try self.renderDashboardList(&res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/dashboards/create") and std.mem.eql(u8, req.method, "POST")) {
            var form = try self.parseForm(req.allocator, req.body);
            defer freeMap(req.allocator, &form);
            const name = form.get("name") orelse "Untitled";
            const id = try self.createDashboard(name);
            const loc = try std.fmt.allocPrint(req.allocator, "/dashboard/{d}", .{id});
            try redirect(&res, loc);
            return res;
        }
        if (std.mem.startsWith(u8, req.path, "/dashboard/")) {
            return try self.dispatchDashboard(req, &res);
        }
        if (std.mem.eql(u8, req.path, "/alerts") and std.mem.eql(u8, req.method, "GET")) {
            try self.renderAlerts(&res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/alerts/create") and std.mem.eql(u8, req.method, "POST")) {
            var form = try self.parseForm(req.allocator, req.body);
            defer freeMap(req.allocator, &form);
            try self.createAlert(.{
                .name = form.get("name") orelse "rule",
                .kind = form.get("kind") orelse "metrics",
                .query = form.get("query") orelse "",
                .op = form.get("op") orelse ">",
                .threshold = try std.fmt.parseFloat(f64, form.get("threshold") orelse "0"),
                .every_seconds = try std.fmt.parseInt(i64, form.get("every_seconds") orelse "30", 10),
            });
            try redirect(&res, "/alerts");
            return res;
        }
        if (std.mem.eql(u8, req.path, "/settings") and std.mem.eql(u8, req.method, "GET")) {
            try self.renderSettings(&res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/status") and std.mem.eql(u8, req.method, "GET")) {
            try self.renderStatus(&res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/settings/scrape-targets") and std.mem.eql(u8, req.method, "POST")) {
            var form = try self.parseForm(req.allocator, req.body);
            defer freeMap(req.allocator, &form);
            try self.createScrapeTarget(form.get("name") orelse "target", form.get("url") orelse "", try std.fmt.parseInt(i64, form.get("interval_seconds") orelse "15", 10));
            try redirect(&res, "/settings");
            return res;
        }
        if (std.mem.startsWith(u8, req.path, "/settings/scrape-target/") and std.mem.eql(u8, req.method, "POST") and std.mem.endsWith(u8, req.path, "/update")) {
            const inner = req.path[24 .. req.path.len - 7];
            const target_id = try std.fmt.parseInt(i64, inner, 10);
            var form = try self.parseForm(req.allocator, req.body);
            defer freeMap(req.allocator, &form);
            try self.updateScrapeTarget(target_id, form.get("name") orelse "target", form.get("url") orelse "", try std.fmt.parseInt(i64, form.get("interval_seconds") orelse "15", 10));
            try redirect(&res, "/settings");
            return res;
        }
        if (std.mem.startsWith(u8, req.path, "/settings/scrape-target/") and std.mem.eql(u8, req.method, "POST") and std.mem.endsWith(u8, req.path, "/delete")) {
            const inner = req.path[24 .. req.path.len - 7];
            const target_id = try std.fmt.parseInt(i64, inner, 10);
            try self.deleteScrapeTarget(target_id);
            try redirect(&res, "/settings");
            return res;
        }
        if (std.mem.eql(u8, req.path, "/logs") and std.mem.eql(u8, req.method, "GET")) {
            try self.renderLogsPage(&res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/api/logs/push") and std.mem.eql(u8, req.method, "POST")) {
            try self.handleLogPush(req.body, &res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/api/metrics/query") and std.mem.eql(u8, req.method, "GET")) {
            res.content_type = "application/json; charset=utf-8";
            try self.handleMetricsQuery(req.query, &res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/api/logs/query") and std.mem.eql(u8, req.method, "GET")) {
            res.content_type = "application/json; charset=utf-8";
            try self.handleLogsQuery(req.query, &res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/api/alerts/state") and std.mem.eql(u8, req.method, "GET")) {
            res.content_type = "application/json; charset=utf-8";
            try self.handleAlertsState(&res);
            return res;
        }
        if (std.mem.eql(u8, req.path, "/api/admin/scrape") and std.mem.eql(u8, req.method, "POST")) {
            try self.scrapeTargets();
            res.content_type = "application/json; charset=utf-8";
            try res.write("{\"ok\":true}");
            return res;
        }

        res.status = .not_found;
        try res.write("not found");
        return res;
    }

    fn dispatchDashboard(self: *App, req: Request, res: *Response) !Response {
        const suffix = req.path[11..];
        const slash = std.mem.indexOfScalar(u8, suffix, '/') orelse suffix.len;
        const id = std.fmt.parseInt(i64, suffix[0..slash], 10) catch {
            res.status = .not_found;
            try res.write("not found");
            return res.*;
        };
        const action = if (slash < suffix.len) suffix[slash..] else "";
        if (std.mem.eql(u8, req.method, "GET") and action.len == 0) {
            try self.renderDashboard(id, res);
            return res.*;
        }
        if (std.mem.eql(u8, req.method, "POST") and std.mem.eql(u8, action, "/rename")) {
            var form = try self.parseForm(req.allocator, req.body);
            defer freeMap(req.allocator, &form);
            try self.renameDashboard(id, form.get("name") orelse "Untitled");
            const loc = try std.fmt.allocPrint(req.allocator, "/dashboard/{d}", .{id});
            try redirect(res, loc);
            return res.*;
        }
        if (std.mem.eql(u8, req.method, "POST") and std.mem.eql(u8, action, "/delete")) {
            try self.deleteDashboard(id);
            try redirect(res, "/");
            return res.*;
        }
        if (std.mem.eql(u8, req.method, "POST") and std.mem.eql(u8, action, "/panels/create")) {
            var form = try self.parseForm(req.allocator, req.body);
            defer freeMap(req.allocator, &form);
            try self.createPanel(id, form.get("kind") orelse "metrics", form.get("title") orelse "Panel", form.get("query") orelse "", 12, 8);
            const loc = try std.fmt.allocPrint(req.allocator, "/dashboard/{d}", .{id});
            try redirect(res, loc);
            return res.*;
        }
        if (std.mem.eql(u8, req.method, "POST") and std.mem.endsWith(u8, action, "/delete")) {
            const ps = action[8 .. action.len - 7];
            const panel_id = try std.fmt.parseInt(i64, ps, 10);
            try self.deletePanel(panel_id);
            const loc = try std.fmt.allocPrint(req.allocator, "/dashboard/{d}", .{id});
            try redirect(res, loc);
            return res.*;
        }
        res.status = .not_found;
        try res.write("not found");
        return res.*;
    }

    fn createDashboard(self: *App, name: []const u8) !i64 {
        const stmt = try self.prepare("INSERT INTO dashboards(name) VALUES(?1)");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, name);
        try stepDone(stmt);
        return c.sqlite3_last_insert_rowid(self.db);
    }

    fn renameDashboard(self: *App, id: i64, name: []const u8) !void {
        const stmt = try self.prepare("UPDATE dashboards SET name=?1 WHERE id=?2");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, name);
        try bindInt(stmt, 2, id);
        try stepDone(stmt);
    }

    fn deleteDashboard(self: *App, id: i64) !void {
        const stmt1 = try self.prepare("DELETE FROM panels WHERE dashboard_id=?1");
        defer _ = c.sqlite3_finalize(stmt1);
        try bindInt(stmt1, 1, id);
        try stepDone(stmt1);
        const stmt2 = try self.prepare("DELETE FROM dashboards WHERE id=?1");
        defer _ = c.sqlite3_finalize(stmt2);
        try bindInt(stmt2, 1, id);
        try stepDone(stmt2);
    }

    fn createPanel(self: *App, dashboard_id: i64, kind: []const u8, title: []const u8, query: []const u8, w: i64, h: i64) !void {
        const stmt = try self.prepare("INSERT INTO panels(dashboard_id, kind, title, query, w, h) VALUES(?1, ?2, ?3, ?4, ?5, ?6)");
        defer _ = c.sqlite3_finalize(stmt);
        try bindInt(stmt, 1, dashboard_id);
        try bindText(stmt, 2, kind);
        try bindText(stmt, 3, title);
        try bindText(stmt, 4, query);
        try bindInt(stmt, 5, w);
        try bindInt(stmt, 6, h);
        try stepDone(stmt);
    }

    fn deletePanel(self: *App, panel_id: i64) !void {
        const stmt = try self.prepare("DELETE FROM panels WHERE id=?1");
        defer _ = c.sqlite3_finalize(stmt);
        try bindInt(stmt, 1, panel_id);
        try stepDone(stmt);
    }

    fn createScrapeTarget(self: *App, name: []const u8, url: []const u8, every: i64) !void {
        const stmt = try self.prepare("INSERT INTO scrape_targets(name, url, interval_seconds) VALUES(?1, ?2, ?3)");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, name);
        try bindText(stmt, 2, url);
        try bindInt(stmt, 3, every);
        try stepDone(stmt);
    }

    fn updateScrapeTarget(self: *App, id: i64, name: []const u8, url: []const u8, every: i64) !void {
        const stmt = try self.prepare("UPDATE scrape_targets SET name=?1, url=?2, interval_seconds=?3 WHERE id=?4");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, name);
        try bindText(stmt, 2, url);
        try bindInt(stmt, 3, every);
        try bindInt(stmt, 4, id);
        try stepDone(stmt);
    }

    fn deleteScrapeTarget(self: *App, id: i64) !void {
        const stmt = try self.prepare("DELETE FROM scrape_targets WHERE id=?1");
        defer _ = c.sqlite3_finalize(stmt);
        try bindInt(stmt, 1, id);
        try stepDone(stmt);
    }

    fn countRows(self: *App, table_name: []const u8) !i64 {
        const sql = try std.fmt.allocPrint(self.allocator, "SELECT COUNT(*) FROM {s}", .{table_name});
        defer self.allocator.free(sql);
        const stmt = try self.prepare(sql);
        defer _ = c.sqlite3_finalize(stmt);
        if (c.sqlite3_step(stmt) != c.SQLITE_ROW) return error.SqliteStepFailed;
        return c.sqlite3_column_int64(stmt, 0);
    }

    fn insertMetric(self: *App, name: []const u8, labels: []const u8, ts_ms: i64, value: f64) !void {
        const stmt = try self.prepare("INSERT INTO metric_samples(name, labels, ts_ms, value) VALUES(?1, ?2, ?3, ?4)");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, name);
        try bindText(stmt, 2, labels);
        try bindInt(stmt, 3, ts_ms);
        try bindDouble(stmt, 4, value);
        try stepDone(stmt);
    }

    fn insertLog(self: *App, labels: []const u8, ts_ms: i64, line: []const u8) !void {
        const stmt = try self.prepare("INSERT INTO logs(labels, ts_ms, line) VALUES(?1, ?2, ?3)");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, labels);
        try bindInt(stmt, 2, ts_ms);
        try bindText(stmt, 3, line);
        try stepDone(stmt);
    }

    fn createAlert(self: *App, input: RuleInput) !void {
        const stmt = try self.prepare("INSERT INTO alert_rules(name, kind, query, op, threshold, every_seconds) VALUES(?1, ?2, ?3, ?4, ?5, ?6)");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, input.name);
        try bindText(stmt, 2, input.kind);
        try bindText(stmt, 3, input.query);
        try bindText(stmt, 4, input.op);
        try bindDouble(stmt, 5, input.threshold);
        try bindInt(stmt, 6, input.every_seconds);
        try stepDone(stmt);
    }

    fn renderDashboardList(self: *App, res: *Response) !void {
        var buf = std.array_list.Managed(u8).init(self.allocator);
        defer buf.deinit();
        var w = buf.writer();
        try w.writeAll("<div class='stack'><h1>Dashboards</h1><form method='post' action='/dashboards/create' class='row'><input name='name' placeholder='Dashboard name'><button type='submit'>Create</button></form><ul>");
        const stmt = try self.prepare("SELECT id, name FROM dashboards ORDER BY id DESC");
        defer _ = c.sqlite3_finalize(stmt);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const id = c.sqlite3_column_int64(stmt, 0);
            const name = sqliteText(stmt, 1);
            const safe_name = try htmlEscapeAlloc(self.allocator, name);
            defer self.allocator.free(safe_name);
            try w.print("<li><a href='/dashboard/{d}'>{s}</a></li>", .{ id, safe_name });
        }
        try w.writeAll("</ul></div>");
        try self.htmlPage(res, "Dashboards", buf.items);
    }

    fn renderDashboard(self: *App, id: i64, res: *Response) !void {
        const name_stmt = try self.prepare("SELECT name FROM dashboards WHERE id=?1");
        defer _ = c.sqlite3_finalize(name_stmt);
        try bindInt(name_stmt, 1, id);
        if (c.sqlite3_step(name_stmt) != c.SQLITE_ROW) {
            res.status = .not_found;
            try res.write("dashboard not found");
            return;
        }
        const name = sqliteText(name_stmt, 0);
        const safe_name = try htmlEscapeAlloc(self.allocator, name);
        defer self.allocator.free(safe_name);
        var buf = std.array_list.Managed(u8).init(self.allocator);
        defer buf.deinit();
        var w = buf.writer();
        try w.print("<div class='stack'><h1>{s}</h1>", .{safe_name});
        try w.print("<form method='post' action='/dashboard/{d}/rename' class='row'><input name='name' value='{s}'><button>Rename</button></form>", .{ id, safe_name });
        try w.print("<form method='post' action='/dashboard/{d}/delete'><button>Delete dashboard</button></form>", .{id});
        try w.print(
            "<div class='panel'><h2>Add panel</h2><form method='post' action='/dashboard/{d}/panels/create' class='stack'><div class='row'><select name='kind'><option value='metrics'>Metrics</option><option value='logs'>Logs</option><option value='stat'>Stat</option></select><input name='title' placeholder='Panel title'></div><textarea name='query' placeholder='PromQL or LogQL'></textarea><button>Add panel</button></form></div>",
            .{id},
        );
        const stmt = try self.prepare("SELECT id, kind, title, query FROM panels WHERE dashboard_id=?1 ORDER BY y, x, id");
        defer _ = c.sqlite3_finalize(stmt);
        try bindInt(stmt, 1, id);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const panel_id = c.sqlite3_column_int64(stmt, 0);
            const kind = sqliteText(stmt, 1);
            const title = sqliteText(stmt, 2);
            const query = sqliteText(stmt, 3);
            const safe_title = try htmlEscapeAlloc(self.allocator, title);
            defer self.allocator.free(safe_title);
            const safe_query = try htmlEscapeAlloc(self.allocator, query);
            defer self.allocator.free(safe_query);
            try w.print("<div class='panel'><div class='row'><strong>{s}</strong><span class='muted'>{s}</span></div>", .{ safe_title, safe_query });
            if (std.mem.eql(u8, kind, "logs")) {
                try w.print("<div id='panel-{d}' class='logs'>loading...</div>", .{panel_id});
            } else {
                try w.print("<div id='panel-{d}' class='chart'></div>", .{panel_id});
            }
            try w.print("<form method='post' action='/dashboard/{d}/panel/{d}/delete'><button>Remove panel</button></form></div>", .{ id, panel_id });
        }
        try w.print("<script src='https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js'></script><script>{s}</script>", .{try self.dashboardJs(id)});
        try w.writeAll("</div>");
        try self.htmlPage(res, name, buf.items);
    }

    fn dashboardJs(self: *App, dashboard_id: i64) ![]u8 {
        const stmt = try self.prepare("SELECT id, kind, query FROM panels WHERE dashboard_id=?1 ORDER BY id");
        defer _ = c.sqlite3_finalize(stmt);
        try bindInt(stmt, 1, dashboard_id);
        var buf = std.array_list.Managed(u8).init(self.allocator);
        var w = buf.writer();
        try w.writeAll("async function load(){");
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const panel_id = c.sqlite3_column_int64(stmt, 0);
            const kind = sqliteText(stmt, 1);
            const query = sqliteText(stmt, 2);
            if (std.mem.eql(u8, kind, "logs")) {
                const enc = try urlEncodeAlloc(self.allocator, query);
                defer self.allocator.free(enc);
                try w.print("{{const r=await fetch('/api/logs/query?query={s}&start='+Date.now()-3600_000+'&end='+Date.now());const d=await r.json();document.getElementById('panel-{d}').textContent=d.lines.map(x=>new Date(x.ts).toISOString()+' '+x.labels+' '+x.line).join('\\n');}}", .{ enc, panel_id });
            } else {
                const enc = try urlEncodeAlloc(self.allocator, query);
                defer self.allocator.free(enc);
                try w.print("{{const r=await fetch('/api/metrics/query?query={s}&start='+Date.now()-3600_000+'&end='+Date.now()+'&step=60');const d=await r.json();const el=document.getElementById('panel-{d}');if(d.series.length===0){{el.textContent='no data';}}else if('{s}'==='stat'){{el.textContent=String(d.series[0].points[d.series[0].points.length-1]?.value ?? 'n/a');}}else{{const chart=echarts.init(el);chart.setOption({{tooltip:{{trigger:'axis'}},legend:{{}},xAxis:{{type:'time'}},yAxis:{{type:'value'}},series:d.series.map(s=>({{name:s.labels,type:'line',showSymbol:false,data:s.points.map(p=>[p.ts,p.value])}}))}});}}}}", .{ enc, panel_id, kind });
            }
        }
        try w.writeAll("}load();setInterval(load,15000);");
        return buf.toOwnedSlice();
    }

    fn renderLogsPage(self: *App, res: *Response) !void {
        const body =
            "<div class='stack'><h1>Logs</h1><div class='row'><input id='q' value='{app=\"demo\"}' style='width:420px'><button onclick='load()'>Run</button></div><div id='out' class='logs'>loading...</div><script>async function load(){const q=encodeURIComponent(document.getElementById('q').value);const r=await fetch('/api/logs/query?query='+q+'&start='+(Date.now()-3600_000)+'&end='+Date.now());const d=await r.json();document.getElementById('out').textContent=(d.lines||[]).map(x=>new Date(x.ts).toISOString()+' '+x.labels+' '+x.line).join('\\n');}load();</script></div>";
        try self.htmlPage(res, "Logs", body);
    }

    fn renderAlerts(self: *App, res: *Response) !void {
        var buf = std.array_list.Managed(u8).init(self.allocator);
        defer buf.deinit();
        var w = buf.writer();
        try w.writeAll("<div class='stack'><h1>Alerts</h1><form method='post' action='/alerts/create' class='stack panel'><input name='name' placeholder='Rule name'><div class='row'><select name='kind'><option value='metrics'>metrics</option><option value='logs'>logs</option></select><input name='query' style='width:520px' placeholder='Query'></div><div class='row'><select name='op'><option value='>'>></option><option value='>='>>=</option><option value='<'><</option><option value='<='><=</option></select><input name='threshold' value='0'><input name='every_seconds' value='30'></div><button>Create rule</button></form><table><thead><tr><th>Name</th><th>Kind</th><th>Query</th><th>State</th><th>Value</th><th>Updated</th></tr></thead><tbody>");
        const stmt = try self.prepare("SELECT r.id, r.name, r.kind, r.query, COALESCE(s.state,'unknown'), COALESCE(s.value,0), COALESCE(s.updated_at,0) FROM alert_rules r LEFT JOIN alert_state s ON s.rule_id=r.id ORDER BY r.id DESC");
        defer _ = c.sqlite3_finalize(stmt);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const safe_name = try htmlEscapeAlloc(self.allocator, sqliteText(stmt, 1));
            defer self.allocator.free(safe_name);
            const safe_kind = try htmlEscapeAlloc(self.allocator, sqliteText(stmt, 2));
            defer self.allocator.free(safe_kind);
            const safe_query = try htmlEscapeAlloc(self.allocator, sqliteText(stmt, 3));
            defer self.allocator.free(safe_query);
            const safe_state = try htmlEscapeAlloc(self.allocator, sqliteText(stmt, 4));
            defer self.allocator.free(safe_state);
            try w.print("<tr><td>{s}</td><td>{s}</td><td>{s}</td><td>{s}</td><td>{d:.3}</td><td class='ts' data-ts='{d}'>{d}</td></tr>", .{ safe_name, safe_kind, safe_query, safe_state, c.sqlite3_column_double(stmt, 5), c.sqlite3_column_int64(stmt, 6), c.sqlite3_column_int64(stmt, 6) });
        }
        try w.writeAll("</tbody></table><div class='panel'><h2>Recent alert history</h2><table><thead><tr><th>Rule</th><th>State</th><th>Value</th><th>Changed</th></tr></thead><tbody>");
        const hist_stmt = try self.prepare("SELECT r.name, h.state, h.value, h.changed_at FROM alert_history h JOIN alert_rules r ON r.id=h.rule_id ORDER BY h.id DESC LIMIT 20");
        defer _ = c.sqlite3_finalize(hist_stmt);
        while (c.sqlite3_step(hist_stmt) == c.SQLITE_ROW) {
            const safe_name = try htmlEscapeAlloc(self.allocator, sqliteText(hist_stmt, 0));
            defer self.allocator.free(safe_name);
            const safe_state = try htmlEscapeAlloc(self.allocator, sqliteText(hist_stmt, 1));
            defer self.allocator.free(safe_state);
            try w.print("<tr><td>{s}</td><td>{s}</td><td>{d:.3}</td><td class='ts' data-ts='{d}'>{d}</td></tr>", .{ safe_name, safe_state, c.sqlite3_column_double(hist_stmt, 2), c.sqlite3_column_int64(hist_stmt, 3), c.sqlite3_column_int64(hist_stmt, 3) });
        }
        try w.writeAll("</tbody></table></div><script>for(const el of document.querySelectorAll('.ts')){const ts=Number(el.dataset.ts||'0');if(ts>0)el.textContent=new Date(ts).toLocaleString();}</script></div>");
        try self.htmlPage(res, "Alerts", buf.items);
    }

    fn renderSettings(self: *App, res: *Response) !void {
        var buf = std.array_list.Managed(u8).init(self.allocator);
        defer buf.deinit();
        var w = buf.writer();
        try w.writeAll("<div class='stack'><h1>Settings</h1><div class='panel'><h2>Metrics scrape targets</h2><form method='post' action='/settings/scrape-targets' class='stack'><input name='name' placeholder='Name'><input name='url' placeholder='http://host:port/metrics'><input name='interval_seconds' value='15'><button>Add target</button></form><ul>");
        const stmt = try self.prepare("SELECT id, name, url, interval_seconds FROM scrape_targets ORDER BY id DESC");
        defer _ = c.sqlite3_finalize(stmt);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const target_id = c.sqlite3_column_int64(stmt, 0);
            const safe_name = try htmlEscapeAlloc(self.allocator, sqliteText(stmt, 1));
            defer self.allocator.free(safe_name);
            const safe_url = try htmlEscapeAlloc(self.allocator, sqliteText(stmt, 2));
            defer self.allocator.free(safe_url);
            try w.print("<li class='panel'><form method='post' action='/settings/scrape-target/{d}/update' class='stack'><div class='row'><input name='name' value='{s}'><input name='url' value='{s}' style='min-width:360px'><input name='interval_seconds' value='{d}' style='width:90px'><button>Save</button></div></form><form method='post' action='/settings/scrape-target/{d}/delete'><button>Delete</button></form></li>", .{ target_id, safe_name, safe_url, c.sqlite3_column_int64(stmt, 3), target_id });
        }
        const dashboards = try self.countRows("dashboards");
        const panels = try self.countRows("panels");
        const targets = try self.countRows("scrape_targets");
        const samples = try self.countRows("metric_samples");
        const logs = try self.countRows("logs");
        const rules = try self.countRows("alert_rules");
        const sessions = try self.countRows("sessions");
        try w.writeAll("</ul><form method='post' action='/api/admin/scrape'><button>Scrape now</button></form></div>");
        try w.print("<div class='panel'><h2>Diagnostics</h2><table><tbody><tr><th>Dashboards</th><td>{d}</td></tr><tr><th>Panels</th><td>{d}</td></tr><tr><th>Scrape targets</th><td>{d}</td></tr><tr><th>Metric samples</th><td>{d}</td></tr><tr><th>Log entries</th><td>{d}</td></tr><tr><th>Alert rules</th><td>{d}</td></tr><tr><th>Sessions</th><td>{d}</td></tr></tbody></table></div>", .{ dashboards, panels, targets, samples, logs, rules, sessions });
        try w.writeAll("<div class='panel'><h2>Logs ingestion</h2><p>POST JSON to <code>/api/logs/push</code> using a Loki-like shape:</p><pre>{\"streams\":[{\"labels\":{\"app\":\"demo\"},\"entries\":[{\"ts\":1710000000000,\"line\":\"hello\"}]}]}</pre></div></div>");
        try self.htmlPage(res, "Settings", buf.items);
    }

    fn renderStatus(self: *App, res: *Response) !void {
        var buf = std.array_list.Managed(u8).init(self.allocator);
        defer buf.deinit();
        var w = buf.writer();
        const dashboards = try self.countRows("dashboards");
        const panels = try self.countRows("panels");
        const targets = try self.countRows("scrape_targets");
        const samples = try self.countRows("metric_samples");
        const logs = try self.countRows("logs");
        const rules = try self.countRows("alert_rules");
        const sessions = try self.countRows("sessions");
        const uptime_ms = nowMs() - self.started_at_ms;
        try w.print(
            "<div class='stack'><h1>Status</h1><div class='panel'><table><tbody><tr><th>Started at</th><td class='ts' data-ts='{d}'>{d}</td></tr><tr><th>Uptime (ms)</th><td>{d}</td></tr><tr><th>Dashboards</th><td>{d}</td></tr><tr><th>Panels</th><td>{d}</td></tr><tr><th>Scrape targets</th><td>{d}</td></tr><tr><th>Metric samples</th><td>{d}</td></tr><tr><th>Log entries</th><td>{d}</td></tr><tr><th>Alert rules</th><td>{d}</td></tr><tr><th>Sessions</th><td>{d}</td></tr><tr><th>Derived logger enabled</th><td>{any}</td></tr><tr><th>Derived logger dropped</th><td>{d}</td></tr></tbody></table></div><div class='panel'><p><code>/healthz</code> returns basic process health. This page gives a tiny authenticated snapshot of stored state.</p></div>",
            .{ self.started_at_ms, self.started_at_ms, uptime_ms, dashboards, panels, targets, samples, logs, rules, sessions, self.derived_logs_enabled, self.derived_dropped },
        );
        try w.writeAll("<script>for(const el of document.querySelectorAll('.ts')){const ts=Number(el.dataset.ts||'0');if(ts>0)el.textContent=new Date(ts).toLocaleString();}</script></div>");
        try self.htmlPage(res, "Status", buf.items);
    }

    fn ingestLogPushPayload(self: *App, body: []const u8) !usize {
        var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, body, .{});
        defer parsed.deinit();
        const root = parsed.value.object;
        const streams = root.get("streams") orelse return error.InvalidJson;
        var inserted: usize = 0;
        for (streams.array.items) |stream_val| {
            const obj = stream_val.object;
            const labels_obj = obj.get("labels") orelse return error.InvalidJson;
            const labels = try canonicalizeJsonObject(self.allocator, labels_obj.object);
            defer self.allocator.free(labels);
            const entries = obj.get("entries") orelse return error.InvalidJson;
            for (entries.array.items) |entry_val| {
                const eobj = entry_val.object;
                const ts_val = eobj.get("ts") orelse return error.InvalidJson;
                const ts = switch (ts_val) {
                    .float => |f| @as(i64, @intFromFloat(f)),
                    .integer => |i| i,
                    else => return error.InvalidJson,
                };
                const line_val = eobj.get("line") orelse return error.InvalidJson;
                const line = switch (line_val) {
                    .string => |s| s,
                    else => return error.InvalidJson,
                };
                try self.insertLog(labels, ts, line);
                inserted += 1;
            }
        }
        return inserted;
    }

    fn handleLogPush(self: *App, body: []const u8, res: *Response) !void {
        const inserted = try self.ingestLogPushPayload(body);
        res.content_type = "application/json; charset=utf-8";
        try res.writer().print("{{\"ok\":true,\"inserted\":{d}}}", .{inserted});
    }

    fn scrapeTargets(self: *App) !void {
        const stmt = try self.prepare("SELECT url FROM scrape_targets ORDER BY id");
        defer _ = c.sqlite3_finalize(stmt);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const url = sqliteText(stmt, 0);
            self.scrapeTarget(url) catch |err| {
                const msg = std.fmt.allocPrint(self.allocator, "scrape failed target={s} err={s}", .{ url, @errorName(err) }) catch null;
                if (msg) |m| {
                    defer self.allocator.free(m);
                    self.emitStableLog("scrape", "error", m);
                }
            };
        }
    }

    fn scrapeTarget(self: *App, url: []const u8) !void {
        const parsed = try parseHttpUrl(url);
        const address = try std.net.Address.resolveIp(parsed.host, parsed.port);
        var tcp = try std.net.tcpConnectToAddress(address);
        defer tcp.close();
        const request = try std.fmt.allocPrint(self.allocator, "GET {s} HTTP/1.1\r\nHost: {s}\r\nConnection: close\r\n\r\n", .{ parsed.path, parsed.host });
        defer self.allocator.free(request);
        try tcp.writeAll(request);
        var raw_list = std.array_list.Managed(u8).init(self.allocator);
        defer raw_list.deinit();
        var temp: [4096]u8 = undefined;
        while (true) {
            const n = try tcp.read(&temp);
            if (n == 0) break;
            try raw_list.appendSlice(temp[0..n]);
        }
        const raw = raw_list.items;
        const header_end = std.mem.indexOf(u8, raw, "\r\n\r\n") orelse return error.BadHttpResponse;
        try self.ingestPrometheusText(raw[header_end + 4 ..], nowMs());
    }

    fn ingestPrometheusText(self: *App, text: []const u8, scrape_ts: i64) !void {
        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |line0| {
            const line = std.mem.trim(u8, line0, " \r\t");
            if (line.len == 0 or line[0] == '#') continue;
            const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse continue;
            const left = line[0..space];
            const right = std.mem.trim(u8, line[space + 1 ..], " ");
            const value = std.fmt.parseFloat(f64, right) catch continue;
            var metric_name = left;
            var labels: []const u8 = "";
            if (std.mem.indexOfScalar(u8, left, '{')) |brace| {
                metric_name = left[0..brace];
                labels = try normalizeLabelString(self.allocator, left[brace + 1 .. left.len - 1]);
                defer self.allocator.free(labels);
            }
            try self.insertMetric(metric_name, labels, scrape_ts, value);
        }
    }

    fn fetchMetricSeries(self: *App, allocator: Allocator, selector: Selector, start_ms: i64, end_ms: i64) ![]Series {
        const stmt = try self.prepare("SELECT labels, ts_ms, value FROM metric_samples WHERE name=?1 AND ts_ms BETWEEN ?2 AND ?3 ORDER BY labels, ts_ms");
        defer _ = c.sqlite3_finalize(stmt);
        try bindText(stmt, 1, selector.name);
        try bindInt(stmt, 2, start_ms);
        try bindInt(stmt, 3, end_ms);
        var map = std.StringHashMap(std.array_list.Managed(SamplePoint)).init(allocator);
        defer {
            var it = map.iterator();
            while (it.next()) |e| {
                self.allocator.free(e.key_ptr.*);
                e.value_ptr.deinit();
            }
            map.deinit();
        }
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const labels = sqliteText(stmt, 0);
            if (!labelsMatch(selector.labels, labels)) continue;
            const key = try allocator.dupe(u8, labels);
            const gop = try map.getOrPut(key);
            if (!gop.found_existing) gop.value_ptr.* = std.array_list.Managed(SamplePoint).init(allocator) else allocator.free(key);
            try gop.value_ptr.append(.{ .ts_ms = c.sqlite3_column_int64(stmt, 1), .value = c.sqlite3_column_double(stmt, 2) });
        }
        var result = std.array_list.Managed(Series).init(allocator);
        var it = map.iterator();
        while (it.next()) |e| {
            try result.append(.{ .labels = try allocator.dupe(u8, e.key_ptr.*), .points = try e.value_ptr.toOwnedSlice() });
        }
        return result.toOwnedSlice();
    }

    fn runPromRange(self: *App, allocator: Allocator, query: []const u8, start_ms: i64, end_ms: i64, step_s: i64) ![]Series {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        var expr = try parsePromExpr(arena.allocator(), std.mem.trim(u8, query, " \t\n"));
        return try self.evalPromRange(allocator, &expr, start_ms, end_ms, step_s * 1000);
    }

    fn evalPromRange(self: *App, allocator: Allocator, expr: *PromExpr, start_ms: i64, end_ms: i64, step_ms: i64) ![]Series {
        switch (expr.*) {
            .selector => |sel| {
                const raw = try self.fetchMetricSeries(allocator, sel, start_ms, end_ms);
                defer freeSeries(allocator, raw);
                return try resampleLastValue(allocator, raw, start_ms, end_ms, step_ms);
            },
            .range_fn => |rf| {
                const window = rf.selector.window_ms orelse 5 * 60 * 1000;
                const raw = try self.fetchMetricSeries(allocator, rf.selector, start_ms - window, end_ms);
                defer freeSeries(allocator, raw);
                return try applyRangeFn(allocator, rf.op, raw, start_ms, end_ms, step_ms, window);
            },
            .agg => |agg| {
                const child = try self.evalPromRange(allocator, agg.expr, start_ms, end_ms, step_ms);
                defer freeSeries(allocator, child);
                return try aggregateSeries(allocator, agg.op, child, start_ms, end_ms, step_ms);
            },
        }
    }

    fn runLogQuery(self: *App, allocator: Allocator, query: []const u8, start_ms: i64, end_ms: i64, step_s: ?i64) !std.json.Value {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const parsed = try parseLogQuery(arena.allocator(), query);
        switch (parsed) {
            .lines => |lq| {
                const entries = try self.fetchLogEntries(allocator, lq.selector, lq.includes, lq.excludes, start_ms, end_ms);
                defer freeLogEntries(allocator, entries);
                var arr = std.json.Array.init(allocator);
                for (entries) |e| {
                    var obj = std.json.ObjectMap.init(allocator);
                    try obj.put("ts", .{ .integer = e.ts_ms });
                    try obj.put("labels", .{ .string = try allocator.dupe(u8, e.labels) });
                    try obj.put("line", .{ .string = try allocator.dupe(u8, e.line) });
                    try arr.append(.{ .object = obj });
                }
                var root = std.json.ObjectMap.init(allocator);
                try root.put("lines", .{ .array = arr });
                return .{ .object = root };
            },
            .range_metric => |rq| {
                const step = (step_s orelse 60) * 1000;
                const window = rq.selector.window_ms orelse 5 * 60 * 1000;
                const entries = try self.fetchLogEntries(allocator, rq.selector, rq.includes, rq.excludes, start_ms - window, end_ms);
                defer freeLogEntries(allocator, entries);
                var pts = std.array_list.Managed(std.json.Value).init(allocator);
                var t = start_ms;
                while (t <= end_ms) : (t += step) {
                    var count: f64 = 0;
                    for (entries) |e| {
                        if (e.ts_ms >= t - window and e.ts_ms <= t) count += 1;
                    }
                    if (std.mem.eql(u8, rq.op, "rate")) count = count / (@as(f64, @floatFromInt(window)) / 1000.0);
                    var point = std.json.ObjectMap.init(allocator);
                    try point.put("ts", .{ .integer = t });
                    try point.put("value", .{ .float = count });
                    try pts.append(.{ .object = point });
                }
                var series_obj = std.json.ObjectMap.init(allocator);
                try series_obj.put("labels", .{ .string = try allocator.dupe(u8, "logs") });
                try series_obj.put("points", .{ .array = pts });
                var series_arr = std.json.Array.init(allocator);
                try series_arr.append(.{ .object = series_obj });
                var root = std.json.ObjectMap.init(allocator);
                try root.put("series", .{ .array = series_arr });
                return .{ .object = root };
            },
        }
    }

    fn fetchLogEntries(self: *App, allocator: Allocator, selector: Selector, includes: [][]const u8, excludes: [][]const u8, start_ms: i64, end_ms: i64) ![]LogEntry {
        const stmt = try self.prepare("SELECT labels, ts_ms, line FROM logs WHERE ts_ms BETWEEN ?1 AND ?2 ORDER BY ts_ms DESC LIMIT 1000");
        defer _ = c.sqlite3_finalize(stmt);
        try bindInt(stmt, 1, start_ms);
        try bindInt(stmt, 2, end_ms);
        var arr = std.array_list.Managed(LogEntry).init(allocator);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const labels = sqliteText(stmt, 0);
            if (!labelsMatch(selector.labels, labels)) continue;
            const line = sqliteText(stmt, 2);
            var ok = true;
            for (includes) |needle| {
                if (std.mem.indexOf(u8, line, needle) == null) ok = false;
            }
            for (excludes) |needle| {
                if (std.mem.indexOf(u8, line, needle) != null) ok = false;
            }
            if (!ok) continue;
            try arr.append(.{ .labels = try allocator.dupe(u8, labels), .ts_ms = c.sqlite3_column_int64(stmt, 1), .line = try allocator.dupe(u8, line) });
        }
        return arr.toOwnedSlice();
    }

    fn evaluateAlerts(self: *App) !void {
        const stmt = try self.prepare("SELECT id, name, kind, query, op, threshold FROM alert_rules");
        defer _ = c.sqlite3_finalize(stmt);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            const rule_id = c.sqlite3_column_int64(stmt, 0);
            const rule_name = sqliteText(stmt, 1);
            const kind = sqliteText(stmt, 2);
            const query = sqliteText(stmt, 3);
            const op = sqliteText(stmt, 4);
            const threshold = c.sqlite3_column_double(stmt, 5);
            const now = nowMs();
            const value = if (std.mem.eql(u8, kind, "logs")) blk: {
                const result = try self.runLogQuery(self.allocator, query, now - 5 * 60 * 1000, now, 60);
                break :blk jsonLastValue(result) orelse 0;
            } else blk: {
                const series = try self.runPromRange(self.allocator, query, now - 5 * 60 * 1000, now, 60);
                defer freeSeries(self.allocator, series);
                break :blk if (series.len == 0 or series[0].points.len == 0) 0 else series[0].points[series[0].points.len - 1].value;
            };
            const prev_state_stmt = try self.prepare("SELECT state FROM alert_state WHERE rule_id=?1");
            defer _ = c.sqlite3_finalize(prev_state_stmt);
            try bindInt(prev_state_stmt, 1, rule_id);
            const prev_state = if (c.sqlite3_step(prev_state_stmt) == c.SQLITE_ROW) sqliteText(prev_state_stmt, 0) else "unknown";
            const firing = compare(value, op, threshold);
            const state = if (firing) "firing" else "inactive";
            const up = try self.prepare("INSERT INTO alert_state(rule_id, state, value, updated_at) VALUES(?1, ?2, ?3, ?4) ON CONFLICT(rule_id) DO UPDATE SET state=excluded.state, value=excluded.value, updated_at=excluded.updated_at");
            defer _ = c.sqlite3_finalize(up);
            try bindInt(up, 1, rule_id);
            try bindText(up, 2, state);
            try bindDouble(up, 3, value);
            try bindInt(up, 4, now);
            try stepDone(up);
            const hist = try self.prepare("INSERT INTO alert_history(rule_id, state, value, changed_at) VALUES(?1, ?2, ?3, ?4)");
            defer _ = c.sqlite3_finalize(hist);
            try bindInt(hist, 1, rule_id);
            try bindText(hist, 2, state);
            try bindDouble(hist, 3, value);
            try bindInt(hist, 4, now);
            try stepDone(hist);
            if (!std.mem.eql(u8, prev_state, state)) {
                const msg = std.fmt.allocPrint(self.allocator, "alert transitioned rule={s} state={s} value={d:.3}", .{ rule_name, state, value }) catch null;
                if (msg) |m| {
                    defer self.allocator.free(m);
                    self.emitStableLog("alerts", "info", m);
                }
            }
        }
    }

    fn handleMetricsQuery(self: *App, query_string: []const u8, res: *Response) !void {
        var query = try parseQueryString(reqToMapAllocator(self.allocator), query_string);
        defer freeMap(self.allocator, &query);
        const q = query.get("query") orelse "";
        const start_ms = try std.fmt.parseInt(i64, query.get("start") orelse "0", 10);
        const end_ms = try std.fmt.parseInt(i64, query.get("end") orelse "0", 10);
        const step = try std.fmt.parseInt(i64, query.get("step") orelse "60", 10);
        const series = try self.runPromRange(self.allocator, q, start_ms, end_ms, step);
        defer freeSeries(self.allocator, series);
        try writeSeriesJson(res.writer(), series);
    }

    fn handleLogsQuery(self: *App, query_string: []const u8, res: *Response) !void {
        var query = try parseQueryString(reqToMapAllocator(self.allocator), query_string);
        defer freeMap(self.allocator, &query);
        const q = query.get("query") orelse "";
        const start_ms = try std.fmt.parseInt(i64, query.get("start") orelse "0", 10);
        const end_ms = try std.fmt.parseInt(i64, query.get("end") orelse "0", 10);
        const step = std.fmt.parseInt(i64, query.get("step") orelse "60", 10) catch 60;
        const v = try self.runLogQuery(self.allocator, q, start_ms, end_ms, step);
        try writeJsonValue(res.writer(), v);
    }

    fn handleAlertsState(self: *App, res: *Response) !void {
        var writer = res.writer();
        try writer.writeAll("{\"alerts\":[");
        var first = true;
        const stmt = try self.prepare("SELECT r.name, s.state, s.value FROM alert_rules r LEFT JOIN alert_state s ON s.rule_id=r.id ORDER BY r.id");
        defer _ = c.sqlite3_finalize(stmt);
        while (c.sqlite3_step(stmt) == c.SQLITE_ROW) {
            if (!first) try writer.writeAll(",");
            first = false;
            try writer.print("{{\"name\":\"{s}\",\"state\":\"{s}\",\"value\":{d:.3}}}", .{ sqliteText(stmt, 0), sqliteText(stmt, 1), c.sqlite3_column_double(stmt, 2) });
        }
        try writer.writeAll("]}");
    }
};

fn sqliteText(stmt: *c.sqlite3_stmt, idx: c_int) []const u8 {
    const txt = c.sqlite3_column_text(stmt, idx);
    const len: usize = @intCast(c.sqlite3_column_bytes(stmt, idx));
    return txt[0..len];
}

fn compare(v: f64, op: []const u8, threshold: f64) bool {
    if (std.mem.eql(u8, op, ">")) return v > threshold;
    if (std.mem.eql(u8, op, ">=")) return v >= threshold;
    if (std.mem.eql(u8, op, "<")) return v < threshold;
    if (std.mem.eql(u8, op, "<=")) return v <= threshold;
    return false;
}

fn timingSafeEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var diff: u8 = 0;
    for (a, b) |x, y| diff |= x ^ y;
    return diff == 0;
}

fn htmlEscapeAlloc(allocator: Allocator, input: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(allocator);
    for (input) |ch| {
        switch (ch) {
            '&' => try out.appendSlice("&amp;"),
            '<' => try out.appendSlice("&lt;"),
            '>' => try out.appendSlice("&gt;"),
            '"' => try out.appendSlice("&quot;"),
            '\'' => try out.appendSlice("&#39;"),
            else => try out.append(ch),
        }
    }
    return out.toOwnedSlice();
}

fn jsonEscapeAlloc(allocator: Allocator, input: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(allocator);
    for (input) |ch| {
        switch (ch) {
            '"' => try out.appendSlice("\\\""),
            '\\' => try out.appendSlice("\\\\"),
            '\n' => try out.appendSlice("\\n"),
            '\r' => try out.appendSlice("\\r"),
            '\t' => try out.appendSlice("\\t"),
            else => try out.append(ch),
        }
    }
    return out.toOwnedSlice();
}

fn reqToMapAllocator(allocator: Allocator) Allocator {
    return allocator;
}

fn urlDecodeAlloc(allocator: Allocator, input: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(allocator);
    var i: usize = 0;
    while (i < input.len) : (i += 1) {
        if (input[i] == '+') {
            try out.append(' ');
        } else if (input[i] == '%' and i + 2 < input.len) {
            const b = try std.fmt.parseInt(u8, input[i + 1 .. i + 3], 16);
            try out.append(b);
            i += 2;
        } else {
            try out.append(input[i]);
        }
    }
    return out.toOwnedSlice();
}

fn urlEncodeAlloc(allocator: Allocator, input: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(allocator);
    for (input) |ch| {
        if (std.ascii.isAlphanumeric(ch) or ch == '-' or ch == '_' or ch == '.' or ch == '~') {
            try out.append(ch);
        } else if (ch == ' ') {
            try out.appendSlice("%20");
        } else {
            try out.writer().print("%{X:0>2}", .{ch});
        }
    }
    return out.toOwnedSlice();
}

fn freeMap(allocator: Allocator, map: *std.StringHashMap([]u8)) void {
    var it = map.iterator();
    while (it.next()) |e| {
        allocator.free(e.key_ptr.*);
        allocator.free(e.value_ptr.*);
    }
    map.deinit();
}

fn parseQueryString(allocator: Allocator, qs: []const u8) !std.StringHashMap([]u8) {
    var map = std.StringHashMap([]u8).init(allocator);
    var it = std.mem.splitScalar(u8, qs, '&');
    while (it.next()) |part| {
        if (part.len == 0) continue;
        const eq = std.mem.indexOfScalar(u8, part, '=') orelse part.len;
        const key = try urlDecodeAlloc(allocator, part[0..eq]);
        const val = if (eq < part.len) try urlDecodeAlloc(allocator, part[eq + 1 ..]) else try allocator.dupe(u8, "");
        try map.put(key, val);
    }
    return map;
}

fn normalizeLabelString(allocator: Allocator, raw: []const u8) ![]u8 {
    if (raw.len == 0) return allocator.dupe(u8, "");
    var parts = std.array_list.Managed([]u8).init(allocator);
    defer {
        for (parts.items) |p| allocator.free(p);
        parts.deinit();
    }
    var it = std.mem.splitScalar(u8, raw, ',');
    while (it.next()) |p0| {
        const p = std.mem.trim(u8, p0, " ");
        if (p.len == 0) continue;
        const eq = std.mem.indexOfScalar(u8, p, '=') orelse continue;
        const k = std.mem.trim(u8, p[0..eq], " ");
        var v = std.mem.trim(u8, p[eq + 1 ..], " ");
        if (v.len >= 2 and v[0] == '"' and v[v.len - 1] == '"') v = v[1 .. v.len - 1];
        try parts.append(try std.fmt.allocPrint(allocator, "{s}={s}", .{ k, v }));
    }
    std.mem.sort([]u8, parts.items, {}, struct {
        fn lessThan(_: void, a: []u8, b: []u8) bool { return std.mem.lessThan(u8, a, b); }
    }.lessThan);
    return std.mem.join(allocator, ",", @as([]const []const u8, @ptrCast(parts.items)));
}

fn canonicalizeJsonObject(allocator: Allocator, obj: std.json.ObjectMap) ![]u8 {
    var parts = std.array_list.Managed([]u8).init(allocator);
    defer {
        for (parts.items) |p| allocator.free(p);
        parts.deinit();
    }
    var it = obj.iterator();
    while (it.next()) |entry| {
        try parts.append(try std.fmt.allocPrint(allocator, "{s}={s}", .{ entry.key_ptr.*, entry.value_ptr.string }));
    }
    std.mem.sort([]u8, parts.items, {}, struct {
        fn lessThan(_: void, a: []u8, b: []u8) bool { return std.mem.lessThan(u8, a, b); }
    }.lessThan);
    return std.mem.join(allocator, ",", @as([]const []const u8, @ptrCast(parts.items)));
}

fn labelsMatch(matchers: []LabelMatcher, labels: []const u8) bool {
    for (matchers) |m| {
        const actual = findLabelValue(labels, m.key) orelse "";
        switch (m.op) {
            .eq => if (!std.mem.eql(u8, actual, m.value)) return false,
            .neq => if (std.mem.eql(u8, actual, m.value)) return false,
        }
    }
    return true;
}

fn findLabelValue(labels: []const u8, key: []const u8) ?[]const u8 {
    var it = std.mem.splitScalar(u8, labels, ',');
    while (it.next()) |item| {
        const eq = std.mem.indexOfScalar(u8, item, '=') orelse continue;
        if (std.mem.eql(u8, item[0..eq], key)) return item[eq + 1 ..];
    }
    return null;
}

fn parseDurationMs(text: []const u8) !i64 {
    if (text.len < 2) return error.InvalidDuration;
    const unit = text[text.len - 1];
    const value = try std.fmt.parseInt(i64, text[0 .. text.len - 1], 10);
    return switch (unit) {
        's' => value * 1000,
        'm' => value * 60 * 1000,
        'h' => value * 60 * 60 * 1000,
        'd' => value * 24 * 60 * 60 * 1000,
        else => error.InvalidDuration,
    };
}

fn parseHttpUrl(url: []const u8) !struct { host: []const u8, port: u16, path: []const u8 } {
    if (!std.mem.startsWith(u8, url, "http://")) return error.UnsupportedScheme;
    const rest = url[7..];
    const slash = std.mem.indexOfScalar(u8, rest, '/') orelse rest.len;
    const hostport = rest[0..slash];
    const path = if (slash < rest.len) rest[slash..] else "/metrics";
    const colon = std.mem.lastIndexOfScalar(u8, hostport, ':');
    return .{
        .host = if (colon) |i| hostport[0..i] else hostport,
        .port = if (colon) |i| try std.fmt.parseInt(u16, hostport[i + 1 ..], 10) else 80,
        .path = path,
    };
}

fn parseSelector(allocator: Allocator, input: []const u8) !Selector {
    const trimmed = std.mem.trim(u8, input, " \t\n");
    var base = trimmed;
    var window_ms: ?i64 = null;
    if (std.mem.lastIndexOfScalar(u8, trimmed, '[')) |i| {
        if (trimmed[trimmed.len - 1] == ']') {
            window_ms = try parseDurationMs(trimmed[i + 1 .. trimmed.len - 1]);
            base = trimmed[0..i];
        }
    }
    var name = base;
    var label_matchers = std.array_list.Managed(LabelMatcher).init(allocator);
    if (std.mem.indexOfScalar(u8, base, '{')) |brace| {
        name = std.mem.trim(u8, base[0..brace], " ");
        const inside = base[brace + 1 .. base.len - 1];
        var parts = std.mem.splitScalar(u8, inside, ',');
        while (parts.next()) |part0| {
            const part = std.mem.trim(u8, part0, " ");
            if (part.len == 0) continue;
            if (std.mem.indexOf(u8, part, "!=")) |idx| {
                const value = stripQuotes(std.mem.trim(u8, part[idx + 2 ..], " "));
                try label_matchers.append(.{ .key = try allocator.dupe(u8, std.mem.trim(u8, part[0..idx], " ")), .op = .neq, .value = try allocator.dupe(u8, value) });
            } else if (std.mem.indexOfScalar(u8, part, '=')) |idx| {
                const value = stripQuotes(std.mem.trim(u8, part[idx + 1 ..], " "));
                try label_matchers.append(.{ .key = try allocator.dupe(u8, std.mem.trim(u8, part[0..idx], " ")), .op = .eq, .value = try allocator.dupe(u8, value) });
            }
        }
    }
    return .{ .name = try allocator.dupe(u8, std.mem.trim(u8, name, " ")), .labels = try label_matchers.toOwnedSlice(), .window_ms = window_ms };
}

fn stripQuotes(v: []const u8) []const u8 {
    return if (v.len >= 2 and v[0] == '"' and v[v.len - 1] == '"') v[1 .. v.len - 1] else v;
}

fn parsePromExpr(allocator: Allocator, input: []const u8) !PromExpr {
    const trimmed = std.mem.trim(u8, input, " \t\n");
    inline for (.{ "sum", "avg", "count", "min", "max" }) |agg| {
        const prefix = agg ++ "(";
        if (std.mem.startsWith(u8, trimmed, prefix) and trimmed[trimmed.len - 1] == ')') {
            const inner = try allocator.create(PromExpr);
            inner.* = try parsePromExpr(allocator, trimmed[prefix.len .. trimmed.len - 1]);
            return .{ .agg = .{ .op = agg, .expr = inner } };
        }
    }
    inline for (.{ "rate", "avg_over_time", "sum_over_time", "count_over_time", "last_over_time" }) |fname| {
        const prefix = fname ++ "(";
        if (std.mem.startsWith(u8, trimmed, prefix) and trimmed[trimmed.len - 1] == ')') {
            return .{ .range_fn = .{ .op = fname, .selector = try parseSelector(allocator, trimmed[prefix.len .. trimmed.len - 1]) } };
        }
    }
    return .{ .selector = try parseSelector(allocator, trimmed) };
}

fn parseLogQuery(allocator: Allocator, input: []const u8) !LogQuery {
    const trimmed = std.mem.trim(u8, input, " \t\n");
    inline for (.{ "count_over_time", "rate" }) |fname| {
        const prefix = fname ++ "(";
        if (std.mem.startsWith(u8, trimmed, prefix) and trimmed[trimmed.len - 1] == ')') {
            const inner = trimmed[prefix.len .. trimmed.len - 1];
            const parsed = try parseLogFilters(allocator, inner);
            return .{ .range_metric = .{ .op = fname, .selector = parsed.selector, .includes = parsed.includes, .excludes = parsed.excludes } };
        }
    }
    const parsed = try parseLogFilters(allocator, trimmed);
    return .{ .lines = .{ .selector = parsed.selector, .includes = parsed.includes, .excludes = parsed.excludes } };
}

fn parseLogFilters(allocator: Allocator, input: []const u8) !struct { selector: Selector, includes: [][]const u8, excludes: [][]const u8 } {
    var rest = std.mem.trim(u8, input, " ");
    var end_selector: usize = rest.len;
    if (std.mem.indexOf(u8, rest, "|=")) |i| end_selector = @min(end_selector, i);
    if (std.mem.indexOf(u8, rest, "!=")) |i| {
        if (i > 0 and rest[i - 1] == ' ') end_selector = @min(end_selector, i);
    }
    const selector = try parseSelector(allocator, std.mem.trim(u8, rest[0..end_selector], " "));
    rest = if (end_selector < rest.len) rest[end_selector..] else "";
    var includes = std.array_list.Managed([]const u8).init(allocator);
    var excludes = std.array_list.Managed([]const u8).init(allocator);
    var i: usize = 0;
    while (i < rest.len) {
        if (std.mem.startsWith(u8, rest[i..], "|=")) {
            i += 2;
            while (i < rest.len and rest[i] == ' ') i += 1;
            const s = parseQuoted(rest, &i);
            try includes.append(try allocator.dupe(u8, s));
        } else if (std.mem.startsWith(u8, rest[i..], "!=")) {
            i += 2;
            while (i < rest.len and rest[i] == ' ') i += 1;
            const s = parseQuoted(rest, &i);
            try excludes.append(try allocator.dupe(u8, s));
        } else i += 1;
    }
    return .{ .selector = selector, .includes = try includes.toOwnedSlice(), .excludes = try excludes.toOwnedSlice() };
}

fn parseQuoted(input: []const u8, idx: *usize) []const u8 {
    if (idx.* >= input.len) return "";
    if (input[idx.*] == '"') {
        const start = idx.* + 1;
        idx.* = start;
        while (idx.* < input.len and input[idx.*] != '"') idx.* += 1;
        const out = input[start..@min(idx.*, input.len)];
        if (idx.* < input.len) idx.* += 1;
        return out;
    }
    const start = idx.*;
    while (idx.* < input.len and input[idx.*] != ' ') idx.* += 1;
    return input[start..idx.*];
}

fn sampleLastBefore(points: []SamplePoint, t: i64) ?f64 {
    var result: ?f64 = null;
    for (points) |p| {
        if (p.ts_ms <= t) result = p.value else break;
    }
    return result;
}

fn resampleLastValue(allocator: Allocator, raw: []Series, start_ms: i64, end_ms: i64, step_ms: i64) ![]Series {
    var out = std.array_list.Managed(Series).init(allocator);
    for (raw) |s| {
        var pts = std.array_list.Managed(SamplePoint).init(allocator);
        var t = start_ms;
        while (t <= end_ms) : (t += step_ms) {
            if (sampleLastBefore(s.points, t)) |v| try pts.append(.{ .ts_ms = t, .value = v });
        }
        try out.append(.{ .labels = try allocator.dupe(u8, s.labels), .points = try pts.toOwnedSlice() });
    }
    return out.toOwnedSlice();
}

fn applyRangeFn(allocator: Allocator, op: []const u8, raw: []Series, start_ms: i64, end_ms: i64, step_ms: i64, window_ms: i64) ![]Series {
    var out = std.array_list.Managed(Series).init(allocator);
    for (raw) |s| {
        var pts = std.array_list.Managed(SamplePoint).init(allocator);
        var t = start_ms;
        while (t <= end_ms) : (t += step_ms) {
            var count: usize = 0;
            var sum: f64 = 0;
            var first: ?SamplePoint = null;
            var last: ?SamplePoint = null;
            for (s.points) |p| {
                if (p.ts_ms >= t - window_ms and p.ts_ms <= t) {
                    if (first == null) first = p;
                    last = p;
                    sum += p.value;
                    count += 1;
                }
            }
            var v: f64 = 0;
            if (std.mem.eql(u8, op, "rate")) {
                if (first != null and last != null and last.?.ts_ms > first.?.ts_ms) {
                    v = (last.?.value - first.?.value) / (@as(f64, @floatFromInt(last.?.ts_ms - first.?.ts_ms)) / 1000.0);
                }
            } else if (std.mem.eql(u8, op, "avg_over_time")) {
                if (count > 0) v = sum / @as(f64, @floatFromInt(count));
            } else if (std.mem.eql(u8, op, "sum_over_time")) {
                v = sum;
            } else if (std.mem.eql(u8, op, "count_over_time")) {
                v = @floatFromInt(count);
            } else if (std.mem.eql(u8, op, "last_over_time")) {
                if (last != null) v = last.?.value;
            }
            try pts.append(.{ .ts_ms = t, .value = v });
        }
        try out.append(.{ .labels = try allocator.dupe(u8, s.labels), .points = try pts.toOwnedSlice() });
    }
    return out.toOwnedSlice();
}

fn aggregateSeries(allocator: Allocator, op: []const u8, series: []Series, start_ms: i64, end_ms: i64, step_ms: i64) ![]Series {
    var pts = std.array_list.Managed(SamplePoint).init(allocator);
    var t = start_ms;
    while (t <= end_ms) : (t += step_ms) {
        var values = std.array_list.Managed(f64).init(allocator);
        defer values.deinit();
        for (series) |s| {
            for (s.points) |p| {
                if (p.ts_ms == t) {
                    try values.append(p.value);
                    break;
                }
            }
        }
        var v: f64 = 0;
        if (values.items.len > 0) {
            if (std.mem.eql(u8, op, "sum")) {
                for (values.items) |x| v += x;
            } else if (std.mem.eql(u8, op, "avg")) {
                for (values.items) |x| v += x;
                v /= @as(f64, @floatFromInt(values.items.len));
            } else if (std.mem.eql(u8, op, "count")) {
                v = @floatFromInt(values.items.len);
            } else if (std.mem.eql(u8, op, "min")) {
                v = values.items[0];
                for (values.items[1..]) |x| v = @min(v, x);
            } else if (std.mem.eql(u8, op, "max")) {
                v = values.items[0];
                for (values.items[1..]) |x| v = @max(v, x);
            }
        }
        try pts.append(.{ .ts_ms = t, .value = v });
    }
    var arr = try allocator.alloc(Series, 1);
    arr[0] = .{ .labels = try allocator.dupe(u8, op), .points = try pts.toOwnedSlice() };
    return arr;
}

fn freeSeries(allocator: Allocator, series: []Series) void {
    for (series) |s| {
        allocator.free(s.labels);
        allocator.free(s.points);
    }
    allocator.free(series);
}

fn freeLogEntries(allocator: Allocator, entries: []LogEntry) void {
    for (entries) |e| {
        allocator.free(e.labels);
        allocator.free(e.line);
    }
    allocator.free(entries);
}

fn writeSeriesJson(writer: anytype, series: []Series) !void {
    try writer.writeAll("{\"series\":[");
    for (series, 0..) |s, i| {
        if (i != 0) try writer.writeAll(",");
        try writer.print("{{\"labels\":\"{s}\",\"points\":[", .{s.labels});
        for (s.points, 0..) |p, j| {
            if (j != 0) try writer.writeAll(",");
            try writer.print("{{\"ts\":{d},\"value\":{d:.6}}}", .{ p.ts_ms, p.value });
        }
        try writer.writeAll("]}");
    }
    try writer.writeAll("]}");
}

fn writeJsonValue(writer: anytype, value: std.json.Value) !void {
    switch (value) {
        .null => try writer.writeAll("null"),
        .bool => |b| try writer.writeAll(if (b) "true" else "false"),
        .integer => |i| try writer.print("{d}", .{i}),
        .float => |f| try writer.print("{d}", .{f}),
        .number_string => |s| try writer.print("{s}", .{s}),
        .string => |s| {
            try writer.writeByte('"');
            for (s) |ch| {
                switch (ch) {
                    '"' => try writer.writeAll("\\\""),
                    '\\' => try writer.writeAll("\\\\"),
                    '\n' => try writer.writeAll("\\n"),
                    '\r' => try writer.writeAll("\\r"),
                    '\t' => try writer.writeAll("\\t"),
                    else => try writer.writeByte(ch),
                }
            }
            try writer.writeByte('"');
        },
        .array => |arr| {
            try writer.writeByte('[');
            for (arr.items, 0..) |item, i| {
                if (i != 0) try writer.writeByte(',');
                try writeJsonValue(writer, item);
            }
            try writer.writeByte(']');
        },
        .object => |obj| {
            try writer.writeByte('{');
            var it = obj.iterator();
            var i: usize = 0;
            while (it.next()) |entry| : (i += 1) {
                if (i != 0) try writer.writeByte(',');
                try writeJsonValue(writer, .{ .string = entry.key_ptr.* });
                try writer.writeByte(':');
                try writeJsonValue(writer, entry.value_ptr.*);
            }
            try writer.writeByte('}');
        },
    }
}

fn jsonLastValue(v: std.json.Value) ?f64 {
    const obj = v.object;
    const series_val = obj.get("series") orelse return null;
    if (series_val.array.items.len == 0) return null;
    const points = series_val.array.items[0].object.get("points") orelse return null;
    if (points.array.items.len == 0) return null;
    const last = points.array.items[points.array.items.len - 1].object.get("value") orelse return null;
    return switch (last) {
        .float => |f| f,
        .integer => |i| @floatFromInt(i),
        else => null,
    };
}

fn parseRequest(allocator: Allocator, bytes: []const u8) !Request {
    const head_end = std.mem.indexOf(u8, bytes, "\r\n\r\n") orelse return error.BadRequest;
    const head = bytes[0..head_end];
    const body = bytes[head_end + 4 ..];
    var lines = std.mem.splitSequence(u8, head, "\r\n");
    const req_line = lines.next() orelse return error.BadRequest;
    var parts = std.mem.splitScalar(u8, req_line, ' ');
    const method = parts.next() orelse return error.BadRequest;
    const target = parts.next() orelse return error.BadRequest;
    const qidx = std.mem.indexOfScalar(u8, target, '?') orelse target.len;
    var headers = std.array_list.Managed(Header).init(allocator);
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        try headers.append(.{ .name = try allocator.dupe(u8, std.mem.trim(u8, line[0..colon], " ")), .value = try allocator.dupe(u8, std.mem.trim(u8, line[colon + 1 ..], " ")) });
    }
    return .{ .allocator = allocator, .method = try allocator.dupe(u8, method), .target = try allocator.dupe(u8, target), .path = try allocator.dupe(u8, target[0..qidx]), .query = try allocator.dupe(u8, if (qidx < target.len) target[qidx + 1 ..] else ""), .headers = try headers.toOwnedSlice(), .body = try allocator.dupe(u8, body) };
}

fn freeRequest(req: *Request) void {
    req.allocator.free(req.method);
    req.allocator.free(req.target);
    req.allocator.free(req.path);
    req.allocator.free(req.query);
    for (req.headers) |h| {
        req.allocator.free(h.name);
        req.allocator.free(h.value);
    }
    req.allocator.free(req.headers);
    req.allocator.free(req.body);
}

fn sendResponse(stream: anytype, res: *Response) !void {
    const reason = switch (res.status) {
        .ok => "OK",
        .created => "Created",
        .found => "Found",
        .bad_request => "Bad Request",
        .unauthorized => "Unauthorized",
        .forbidden => "Forbidden",
        .not_found => "Not Found",
        .method_not_allowed => "Method Not Allowed",
        .internal_server_error => "Internal Server Error",
    };
    var header_buf = std.array_list.Managed(u8).init(std.heap.page_allocator);
    defer header_buf.deinit();
    try header_buf.writer().print("HTTP/1.1 {d} {s}\r\nContent-Type: {s}\r\nContent-Length: {d}\r\n", .{ @intFromEnum(res.status), reason, res.content_type, res.body.items.len });
    for (res.headers.items) |h| try header_buf.writer().print("{s}: {s}\r\n", .{ h.name, h.value });
    try header_buf.writer().writeAll("Connection: close\r\n\r\n");
    try stream.writeAll(header_buf.items);
    try stream.writeAll(res.body.items);
}

fn handleConnection(app: *App, conn: std.net.Server.Connection) !void {
    defer conn.stream.close();
    var buf: [1024 * 1024]u8 = undefined;
    const n = try conn.stream.read(&buf);
    const allocator = std.heap.page_allocator;
    var req = parseRequest(allocator, buf[0..n]) catch {
        var res = Response.init(allocator);
        defer res.deinit();
        res.status = .bad_request;
        try res.write("bad request");
        try sendResponse(conn.stream, &res);
        return;
    };
    defer freeRequest(&req);
    var res = app.dispatch(req) catch |err| blk: {
        std.log.err("request failed: {}", .{err});
        var r = Response.init(allocator);
        r.status = .internal_server_error;
        try r.write("internal server error");
        break :blk r;
    };
    defer res.deinit();
    try sendResponse(conn.stream, &res);
}

fn scrapeThread(app: *App) void {
    while (true) {
        app.scrapeTargets() catch |err| {
            std.log.err("scrape loop: {}", .{err});
            const msg = std.fmt.allocPrint(app.allocator, "scrape loop error err={s}", .{@errorName(err)}) catch null;
            if (msg) |m| {
                defer app.allocator.free(m);
                app.emitStableLog("scrape", "error", m);
            }
        };
        std.Thread.sleep(15 * std.time.ns_per_s);
    }
}

fn alertsThread(app: *App) void {
    while (true) {
        app.evaluateAlerts() catch |err| {
            std.log.err("alert loop: {}", .{err});
            const msg = std.fmt.allocPrint(app.allocator, "alert loop error err={s}", .{@errorName(err)}) catch null;
            if (msg) |m| {
                defer app.allocator.free(m);
                app.emitStableLog("alerts", "error", m);
            }
        };
        std.Thread.sleep(30 * std.time.ns_per_s);
    }
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const data_dir = std.process.getEnvVarOwned(allocator, "FACEPLANT_DATA_DIR") catch try allocator.dupe(u8, "./data");
    defer allocator.free(data_dir);
    const port = std.fmt.parseInt(u16, std.process.getEnvVarOwned(allocator, "FACEPLANT_PORT") catch try allocator.dupe(u8, "8080"), 10) catch 8080;

    var app = try App.init(allocator, data_dir);
    defer app.deinit();
    app.emitStableLog("lifecycle", "info", "faceplant started");

    _ = try std.Thread.spawn(.{}, scrapeThread, .{&app});
    _ = try std.Thread.spawn(.{}, alertsThread, .{&app});

    const address = try std.net.Address.parseIp("0.0.0.0", port);
    var server = try address.listen(.{ .reuse_address = true });
    defer server.deinit();
    std.log.info("faceplant listening on http://127.0.0.1:{d}", .{port});
    while (true) {
        const conn = try server.accept();
        _ = try std.Thread.spawn(.{}, handleConnection, .{ &app, conn });
    }
}

test "auth sets secret when env missing" {
    const allocator = std.heap.page_allocator;
    const dir = "zig-cache/test-auth";
    std.fs.cwd().deleteTree(dir) catch {};
    var app = try App.init(allocator, dir);
    defer app.deinit();
    try app.ensureSecret("hello");
    try std.testing.expect(app.checkSecret("hello"));
    try std.testing.expect(!app.checkSecret("nope"));
}

test "dashboard crud and route protection" {
    const allocator = std.heap.page_allocator;
    const dir = "zig-cache/test-dash";
    std.fs.cwd().deleteTree(dir) catch {};
    var app = try App.init(allocator, dir);
    defer app.deinit();
    try app.ensureSecret("secret");
    const token = try app.createSession();
    defer allocator.free(token);
    const cookie = try std.fmt.allocPrint(allocator, "faceplant_session={s}", .{token});
    defer allocator.free(cookie);
    const raw = try std.fmt.allocPrint(allocator, "GET / HTTP/1.1\r\nCookie: {s}\r\n\r\n", .{cookie});
    defer allocator.free(raw);
    var req = try parseRequest(allocator, raw);
    defer freeRequest(&req);
    var res = try app.dispatch(req);
    defer res.deinit();
    try std.testing.expect(res.status == .ok);
    const id = try app.createDashboard("Main");
    try app.renameDashboard(id, "Renamed<script>alert(1)</script>");
    try app.createPanel(id, "metrics", "CPU <peak>", "cpu_usage{host=\"a\"}", 12, 8);

    const dash_raw = try std.fmt.allocPrint(allocator, "GET /dashboard/{d} HTTP/1.1\r\nCookie: {s}\r\n\r\n", .{ id, cookie });
    defer allocator.free(dash_raw);
    var dash_req = try parseRequest(allocator, dash_raw);
    defer freeRequest(&dash_req);
    var dash_res = try app.dispatch(dash_req);
    defer dash_res.deinit();
    try std.testing.expect(dash_res.status == .ok);
    try std.testing.expect(std.mem.indexOf(u8, dash_res.body.items, "Renamed&lt;script&gt;alert(1)&lt;/script&gt;") != null);
    try std.testing.expect(std.mem.indexOf(u8, dash_res.body.items, "CPU &lt;peak&gt;") != null);
    try std.testing.expect(std.mem.indexOf(u8, dash_res.body.items, "<script>alert(1)</script>") == null);

    try app.deletePanel(1);
    try app.deleteDashboard(id);
}

test "metrics ingestion and prom queries" {
    const allocator = std.heap.page_allocator;
    const dir = "zig-cache/test-metrics";
    std.fs.cwd().deleteTree(dir) catch {};
    var app = try App.init(allocator, dir);
    defer app.deinit();
    try app.insertMetric("cpu_usage", "host=a", 1000, 1);
    try app.insertMetric("cpu_usage", "host=a", 2000, 2);
    try app.insertMetric("cpu_usage", "host=b", 1000, 3);
    try app.insertMetric("cpu_usage", "host=b", 2000, 4);
    const s1 = try app.runPromRange(allocator, "cpu_usage{host=\"a\"}", 1000, 2000, 1);
    defer freeSeries(allocator, s1);
    try std.testing.expectEqual(@as(usize, 1), s1.len);
    try std.testing.expectEqual(@as(f64, 2), s1[0].points[1].value);
    const s2 = try app.runPromRange(allocator, "sum(cpu_usage)", 1000, 2000, 1);
    defer freeSeries(allocator, s2);
    try std.testing.expectEqual(@as(f64, 6), s2[0].points[1].value);
    try app.insertMetric("requests_total", "job=demo", 0, 0);
    try app.insertMetric("requests_total", "job=demo", 1000, 10);
    const s3 = try app.runPromRange(allocator, "rate(requests_total{job=\"demo\"}[1s])", 1000, 1000, 1);
    defer freeSeries(allocator, s3);
    try std.testing.expectApproxEqRel(@as(f64, 10), s3[0].points[0].value, 0.001);
}

test "logs ingestion and logql queries" {
    const allocator = std.heap.page_allocator;
    const dir = "zig-cache/test-logs";
    std.fs.cwd().deleteTree(dir) catch {};
    var app = try App.init(allocator, dir);
    defer app.deinit();
    try app.insertLog("app=demo,level=info", 1000, "hello world");
    try app.insertLog("app=demo,level=error", 2000, "boom happened");
    var v = try app.runLogQuery(allocator, "{app=\"demo\"} |= \"boom\"", 0, 3000, null);
    try std.testing.expect(v.object.get("lines").?.array.items.len == 1);
    const v2 = try app.runLogQuery(allocator, "count_over_time({app=\"demo\"}[5m])", 0, 3000, 1);
    try std.testing.expect(jsonLastValue(v2).? == 2);
}

test "internal stable and derived loggers" {
    const allocator = std.heap.page_allocator;
    const dir = "zig-cache/test-internal-loggers";
    std.fs.cwd().deleteTree(dir) catch {};
    var app = try App.init(allocator, dir);
    defer app.deinit();

    app.emitStableLog("alerts", "info", "stable hello");
    const stable = try app.runLogQuery(allocator, "{app=\"faceplant\",source=\"self\",logger=\"stable\",component=\"alerts\"} |= \"stable hello\"", 0, App.nowMs() + 1000, null);
    try std.testing.expectEqual(@as(usize, 1), stable.object.get("lines").?.array.items.len);

    app.emitDerivedLog("logs", "debug", "derived hello");
    const none = try app.runLogQuery(allocator, "{app=\"faceplant\",source=\"self\",logger=\"derived\"}", 0, App.nowMs() + 1000, null);
    try std.testing.expectEqual(@as(usize, 0), none.object.get("lines").?.array.items.len);

    app.derived_logs_enabled = true;
    app.derived_tokens = 1;
    app.derived_capacity = 1;
    app.derived_refill_per_sec = 0;
    app.derived_last_refill_ms = App.nowMs();
    app.emitDerivedLog("logs", "debug", "derived one");
    app.emitDerivedLog("logs", "debug", "derived two");
    const derived = try app.runLogQuery(allocator, "{app=\"faceplant\",source=\"self\",logger=\"derived\"}", 0, App.nowMs() + 1000, null);
    try std.testing.expectEqual(@as(usize, 1), derived.object.get("lines").?.array.items.len);
    try std.testing.expectEqual(@as(u64, 1), app.derived_dropped);

    app.emitStableLog("auth", "info", "flush dropped summary");
    const summary = try app.runLogQuery(allocator, "{app=\"faceplant\",source=\"self\",logger=\"stable\",component=\"internal_logger\"} |= \"derived logger dropped 1 event(s)\"", 0, App.nowMs() + 1000, null);
    try std.testing.expectEqual(@as(usize, 1), summary.object.get("lines").?.array.items.len);
    try std.testing.expectEqual(@as(u64, 0), app.derived_dropped);
}

test "alert evaluation" {
    const allocator = std.heap.page_allocator;
    const dir = "zig-cache/test-alerts";
    std.fs.cwd().deleteTree(dir) catch {};
    var app = try App.init(allocator, dir);
    defer app.deinit();
    const now = App.nowMs();
    try app.insertMetric("cpu_usage", "host=a", now - 1000, 95);
    try app.createAlert(.{ .name = "High CPU", .kind = "metrics", .query = "max(cpu_usage)", .op = ">", .threshold = 90, .every_seconds = 30 });
    try app.evaluateAlerts();
    const stmt = try app.prepare("SELECT state FROM alert_state WHERE rule_id=1");
    defer _ = c.sqlite3_finalize(stmt);
    try std.testing.expect(c.sqlite3_step(stmt) == c.SQLITE_ROW);
    try std.testing.expect(std.mem.eql(u8, sqliteText(stmt, 0), "firing"));
    const hist = try app.prepare("SELECT COUNT(*) FROM alert_history WHERE rule_id=1");
    defer _ = c.sqlite3_finalize(hist);
    try std.testing.expect(c.sqlite3_step(hist) == c.SQLITE_ROW);
    try std.testing.expect(c.sqlite3_column_int64(hist, 0) >= 1);
}

test "settings scrape target update delete and logout routes" {
    const allocator = std.heap.page_allocator;
    const dir = "zig-cache/test-settings-routes";
    std.fs.cwd().deleteTree(dir) catch {};
    var app = try App.init(allocator, dir);
    defer app.deinit();
    try app.ensureSecret("secret");
    const token = try app.createSession();
    defer allocator.free(token);
    const cookie = try std.fmt.allocPrint(allocator, "faceplant_session={s}", .{token});
    defer allocator.free(cookie);

    const add_body = "name=demo&url=http%3A%2F%2F127.0.0.1%3A9000%2Fmetrics&interval_seconds=15";
    const add_raw = try std.fmt.allocPrint(allocator, "POST /settings/scrape-targets HTTP/1.1\r\nCookie: {s}\r\nContent-Length: {d}\r\n\r\n{s}", .{ cookie, add_body.len, add_body });
    defer allocator.free(add_raw);
    var add_req = try parseRequest(allocator, add_raw);
    defer freeRequest(&add_req);
    var add_res = try app.dispatch(add_req);
    defer add_res.deinit();
    try std.testing.expect(add_res.status == .found);

    const count1 = try app.prepare("SELECT COUNT(*) FROM scrape_targets");
    defer _ = c.sqlite3_finalize(count1);
    try std.testing.expect(c.sqlite3_step(count1) == c.SQLITE_ROW);
    try std.testing.expectEqual(@as(i64, 1), c.sqlite3_column_int64(count1, 0));

    const update_body = "name=prod&url=http%3A%2F%2F127.0.0.1%3A9100%2Fmetrics&interval_seconds=30";
    const update_raw = try std.fmt.allocPrint(allocator, "POST /settings/scrape-target/1/update HTTP/1.1\r\nCookie: {s}\r\nContent-Length: {d}\r\n\r\n{s}", .{ cookie, update_body.len, update_body });
    defer allocator.free(update_raw);
    var update_req = try parseRequest(allocator, update_raw);
    defer freeRequest(&update_req);
    var update_res = try app.dispatch(update_req);
    defer update_res.deinit();
    try std.testing.expect(update_res.status == .found);

    const check = try app.prepare("SELECT name, url, interval_seconds FROM scrape_targets WHERE id=1");
    defer _ = c.sqlite3_finalize(check);
    try std.testing.expect(c.sqlite3_step(check) == c.SQLITE_ROW);
    try std.testing.expect(std.mem.eql(u8, sqliteText(check, 0), "prod"));
    try std.testing.expect(std.mem.eql(u8, sqliteText(check, 1), "http://127.0.0.1:9100/metrics"));
    try std.testing.expectEqual(@as(i64, 30), c.sqlite3_column_int64(check, 2));

    const settings_raw = try std.fmt.allocPrint(allocator, "GET /settings HTTP/1.1\r\nCookie: {s}\r\n\r\n", .{cookie});
    defer allocator.free(settings_raw);
    var settings_req = try parseRequest(allocator, settings_raw);
    defer freeRequest(&settings_req);
    var settings_res = try app.dispatch(settings_req);
    defer settings_res.deinit();
    try std.testing.expect(settings_res.status == .ok);
    try std.testing.expect(std.mem.indexOf(u8, settings_res.body.items, "Diagnostics") != null);

    const del_raw = try std.fmt.allocPrint(allocator, "POST /settings/scrape-target/1/delete HTTP/1.1\r\nCookie: {s}\r\nContent-Length: 0\r\n\r\n", .{cookie});
    defer allocator.free(del_raw);
    var del_req = try parseRequest(allocator, del_raw);
    defer freeRequest(&del_req);
    var del_res = try app.dispatch(del_req);
    defer del_res.deinit();
    try std.testing.expect(del_res.status == .found);

    const count2 = try app.prepare("SELECT COUNT(*) FROM scrape_targets");
    defer _ = c.sqlite3_finalize(count2);
    try std.testing.expect(c.sqlite3_step(count2) == c.SQLITE_ROW);
    try std.testing.expectEqual(@as(i64, 0), c.sqlite3_column_int64(count2, 0));

    const logout_raw = try std.fmt.allocPrint(allocator, "POST /logout HTTP/1.1\r\nCookie: {s}\r\nContent-Length: 0\r\n\r\n", .{cookie});
    defer allocator.free(logout_raw);
    var logout_req = try parseRequest(allocator, logout_raw);
    defer freeRequest(&logout_req);
    var logout_res = try app.dispatch(logout_req);
    defer logout_res.deinit();
    try std.testing.expect(logout_res.status == .found);
    try std.testing.expect(!(try app.sessionValid(token)));
}

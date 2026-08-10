const webUiSnapshot = "2.5-nightly-2026-07-30";

interface Target {
  source: string;
  library: string;
  sha256: string;
}

const targets: Record<string, Target> = {
  "x86_64-unknown-linux-gnu": {
    source: "native/x86_64-unknown-linux-gnu/libwebui-2.so",
    library: "libwebui-2.so",
    sha256: "ecca096b65f7733db44dfaa28f35bd98da6e2d1aadcfcb2e2368981aee20ad57",
  },
  "aarch64-unknown-linux-gnu": {
    source: "native/aarch64-unknown-linux-gnu/libwebui-2.so",
    library: "libwebui-2.so",
    sha256: "fef75489a44ab85730b4285dc8cefda389a4c44ddaf5abb244759df249cace82",
  },
  "x86_64-apple-darwin": {
    source: "native/x86_64-apple-darwin/libwebui-2.dylib",
    library: "libwebui-2.dylib",
    sha256: "fbdc419f49d63b30360019199d2a67cfb160675e8939a7ba28b484181c31e222",
  },
  "aarch64-apple-darwin": {
    source: "native/aarch64-apple-darwin/libwebui-2.dylib",
    library: "libwebui-2.dylib",
    sha256: "5dff107cc17a1aa683c945dda74b79027df1836035e0c0b055c304c99ddb7fc8",
  },
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function run(command: string[]): Promise<void> {
  const result = await new Deno.Command(command[0], {
    args: command.slice(1),
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.code}`,
    );
  }
}

const targetName = Deno.env.get("EIP_TARGET") ?? Deno.build.target;
const target = targets[targetName];
if (!target) throw new Error(`unsupported EIP_TARGET ${targetName}`);
const explicitTarget = Deno.env.has("EIP_TARGET");
const outputDirectory = explicitTarget ? `dist/${targetName}` : "dist";
const executable = `${outputDirectory}/editing-in-progress`;
const libraryDirectory = `${outputDirectory}/lib`;
const library = await Deno.readFile(target.source);
if (await sha256(library) !== target.sha256) {
  throw new Error(`vendored WebUI checksum mismatch for ${targetName}`);
}

try {
  await Deno.remove(outputDirectory, { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
await run([Deno.execPath(), "task", "build:ui"]);
await Deno.mkdir(libraryDirectory, { recursive: true });
await Deno.writeFile(`${libraryDirectory}/${target.library}`, library, {
  mode: 0o644,
});
const runPermission = targetName.endsWith("-linux-gnu")
  ? ["--allow-run=firefox,google-chrome"]
  : [];
await run([
  Deno.execPath(),
  "compile",
  "--target",
  targetName,
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-env=HOME,USER,EIP_WEBUI_LIBRARY_PATH",
  ...runPermission,
  "--allow-ffi",
  "--include",
  "ui/dist",
  "--exclude-unused-npm",
  "--app-name",
  "editing-in-progress",
  "--output",
  executable,
  "server/main.ts",
]);

console.log(
  `Built ${executable} with pinned WebUI ${webUiSnapshot} sidecar ${libraryDirectory}/${target.library}`,
);

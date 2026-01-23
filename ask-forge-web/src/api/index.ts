import { Hono } from "hono";

const api = new Hono();

api.get("/health", (c) => {
	return c.json({ status: "ok" });
});

// TODO: Add ask-forge integration routes here

export default api;

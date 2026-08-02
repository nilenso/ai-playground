export type Mode = "serve" | "edit" | "edit-and-serve";

export function parseMode(args: readonly string[]): Mode {
  if (args.length === 1 && args[0] === "serve") return "serve";
  if (args.length === 1 && args[0] === "edit") return "edit";
  if (args.length === 2 && args[0] === "edit" && args[1] === "--serve") {
    return "edit-and-serve";
  }
  throw new Error("usage: deno task start -- (serve | edit [--serve])");
}

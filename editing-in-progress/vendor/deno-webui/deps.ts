/*
 * Native-library resolver for the vendored Deno-WebUI 2.5.15 binding.
 * Unlike upstream, this never downloads code at runtime. The release build
 * places a checksummed WebUI 2.5.0-beta.3 library beside the executable.
 */

function libraryName(): string {
  switch (Deno.build.os) {
    case "windows":
      return "webui-2.dll";
    case "darwin":
      return "libwebui-2.dylib";
    default:
      return "libwebui-2.so";
  }
}

function dirname(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 0) throw new Error("cannot determine executable directory");
  return path.slice(0, separator);
}

function resolveLibraryPath(): string {
  const override = Deno.env.get("EIP_WEBUI_LIBRARY_PATH");
  if (override) return override;
  if (Deno.build.standalone) {
    return `${dirname(Deno.execPath())}/lib/${libraryName()}`;
  }
  return `${Deno.cwd()}/dist/lib/${libraryName()}`;
}

export const libPath = resolveLibraryPath();
try {
  const info = await Deno.stat(libPath);
  if (!info.isFile) throw new Error("path is not a file");
} catch (error) {
  throw new Error(
    `WebUI native library is unavailable at ${libPath}; run 'deno task build' or set EIP_WEBUI_LIBRARY_PATH`,
    { cause: error },
  );
}

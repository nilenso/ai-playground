const outputDirectory = "ui/dist";

try {
  await Deno.remove(outputDirectory, { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

const result = await new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--node-modules-dir=auto",
    "--platform=browser",
    "--minify",
    "-o",
    `${outputDirectory}/app.js`,
    "ui/src/index.tsx",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();

if (!result.success) Deno.exit(result.code);

await Deno.writeTextFile(
  `${outputDirectory}/index.html`,
  `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta name="color-scheme" content="light" />
		<title>Editing in Progress</title>
		<link rel="stylesheet" href="/app.css" />
		<script type="module" src="/app.js"></script>
	</head>
	<body><div id="root"></div></body>
</html>
`,
);

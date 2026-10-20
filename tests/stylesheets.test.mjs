import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("custom CSS stays deployment-local while absolute external stylesheets are preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bbb-css-"));
  try {
    const config = join(directory, "styles.toml");
    await writeFile(config, '[params]\ncustom_css = ["css/custom.css", "https://cdn.example.org/theme.css"]\n');
    for (const baseURL of ["https://www.blatbastards.com/", "https://branch-preview.example/", "http://localhost:8788/"]) {
      const destination = join(directory, "public");
      execFileSync("hugo", ["--config", `config.toml,${config}`, "--baseURL", baseURL,
        "--destination", destination, "--quiet"], { cwd: root, stdio: "pipe" });
      const html = await readFile(join(destination, "rides/bastards-bushrangers/index.html"), "utf8");
      assert.ok(html.includes('href="/css/custom.css"'), baseURL);
      assert.ok(!html.includes('href="https://www.blatbastards.com/css/custom.css"'), baseURL);
      assert.ok(html.includes('href="https://cdn.example.org/theme.css"'), baseURL);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-paths.ts");
}

test("encodeFilePathForApi keeps a UNC root inside the first segment", async () => {
  const { encodeFilePathForApi } = await loadSubject();
  // The catch-all route cannot carry a literal "//" prefix — URL routing
  // normalizes it away — so the root is folded into segment one as %2F%2Fhost.
  assert.equal(
    encodeFilePathForApi("\\\\192.0.2.1\\share\\dir"),
    "%2F%2F192.0.2.1/share/dir",
  );
  assert.equal(
    encodeFilePathForApi("//192.0.2.1/share/dir"),
    "%2F%2F192.0.2.1/share/dir",
  );
  assert.equal(
    encodeFilePathForApi("\\\\192.0.2.1\\share"),
    "%2F%2F192.0.2.1/share",
  );
});

test("encodeFilePathForApi encodes drive and POSIX paths per segment", async () => {
  const { encodeFilePathForApi } = await loadSubject();
  assert.equal(encodeFilePathForApi("D:\\repo\\a file.ts"), "D%3A/repo/a%20file.ts");
  assert.equal(encodeFilePathForApi("/tmp/a file.ts"), "tmp/a%20file.ts");
  assert.equal(encodeFilePathForApi("/tmp/dir/"), "tmp/dir");
});

test("getFileName and getFileDirectory handle UNC paths", async () => {
  const { getFileName, getFileDirectory } = await loadSubject();
  assert.equal(getFileName("\\\\host\\share\\dir\\file.ts"), "file.ts");
  assert.equal(getFileDirectory("\\\\host\\share\\dir\\file.ts"), "//host/share/dir");
  assert.equal(getFileDirectory("//host/share/dir"), "//host/share");
});

test("joinFilePath preserves the UNC root", async () => {
  const { joinFilePath } = await loadSubject();
  assert.equal(joinFilePath("\\\\host\\share\\dir", "child"), "//host/share/dir/child");
});

test("getRelativeFilePath strips a UNC cwd prefix", async () => {
  const { getRelativeFilePath } = await loadSubject();
  assert.equal(
    getRelativeFilePath("\\\\host\\share\\dir\\sub\\file.ts", "\\\\host\\share\\dir"),
    "sub/file.ts",
  );
});

test("fileReadApiUrl names the read route and carries the session when there is one", async () => {
  const { fileReadApiUrl } = await loadSubject();
  assert.equal(fileReadApiUrl("/home/me/proj/a.png"), "/api/files/home/me/proj/a.png?type=read");
  // A chat image outside the browsable roots is read because the session
  // mentions its path (`lib/session-file-references-core.ts`).
  assert.equal(
    fileReadApiUrl("/tmp/a shot.png", "01a18db3-6322-71f5-ba92-49ca0d29dc5d"),
    "/api/files/tmp/a%20shot.png?type=read&sessionId=01a18db3-6322-71f5-ba92-49ca0d29dc5d",
  );
  assert.equal(fileReadApiUrl("/tmp/a.png", null), "/api/files/tmp/a.png?type=read");
});

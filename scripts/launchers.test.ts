import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/**
 * 为什么要有这条测试：
 * cmd.exe 读批处理是**按字节**的，遇到 UTF-8 多字节字符会在续读时错位 ——
 * 实测一个含「」和：的 echo 行被切成了两半，后半截被当成命令去执行：
 *     'ot' is not recognized as an internal or external command
 *     '开：桌面「牢大」按' is not recognized ...
 * 加 BOM 也治不好（同一次实测里带 BOM 和不带 BOM 都错）。
 * 所以规矩是：**.cmd 只管调用，中文一律由 bun / PowerShell 脚本打印**。
 */
describe("双击启动器（.cmd）", () => {
  const files = readdirSync(root).filter(
    (f) => f.toLowerCase().endsWith(".cmd") && statSync(join(root, f)).isFile(),
  );

  test("find some launchers at all", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * .ps1 反过来：**必须有 UTF-8 BOM**。
   * PowerShell 5.1 没有 BOM 就按 GBK 读，中文全变乱码 ——
   * 轻则提示语变成"寮曟搸"，重则乱码里的引号把脚本直接读崩
   * （以前有个 .ps1 就这么挂的：Array index expression is missing）。
   */
  test("every .ps1 starts with a UTF-8 BOM", () => {
    const scripts = readdirSync(join(root, "scripts")).filter((f) => f.endsWith(".ps1"));
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for (const file of scripts) {
      const head = readFileSync(join(root, "scripts", file)).subarray(0, 3);
      expect([file, head.toString("hex")]).toEqual([file, "efbbbf"]);
    }
  });

  test("every .cmd is pure ASCII (Chinese is printed by the scripts)", () => {
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      const nonAscii = [...text].filter((ch) => (ch.codePointAt(0) ?? 0) > 127);
      expect([file, nonAscii.length]).toEqual([file, 0]);
    }
  });
});

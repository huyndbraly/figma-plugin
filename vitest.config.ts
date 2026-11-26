import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees/ and carry a full copy of
    // tests/; without this every suite ran once per worktree, and the
    // election tests of two copies fought over the same ports.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});

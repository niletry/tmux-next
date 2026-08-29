import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 一个插件的磁盘状态放哪。
 *
 * 路径在函数里现读，不在模块加载时捕获——测试要能先设 env 再调用，这是仓库
 * 里每条状态路径都守的规矩。
 *
 * 制品库正好落在 TMUX_NEXT_GALLERY_DIR 和 ~/.tmux-next/gallery 上，跟搬家前
 * 一模一样：零迁移，tmux-next-gallery 那个 skill 一个字都不用改。
 */
export function pluginStateDir(id: string): string {
  const env = `TMUX_NEXT_${id.toUpperCase().replace(/-/g, "_")}_DIR`;
  return process.env[env] || join(homedir(), ".tmux-next", id);
}

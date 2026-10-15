export interface LauncherWindow {
  isMinimized(): boolean; restore(): void; show(): void; focus(): void;
}
export function focusLauncherWindow(window: LauncherWindow | undefined): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

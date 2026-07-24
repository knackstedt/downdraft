export async function exportGame(args: string[]): Promise<void> {
  console.log("[DownDraft] Exporting game for distribution...");

  const target = args.find((a) => !a.startsWith("-")) ?? "all";
  console.log(`[DownDraft] Export target: ${target}`);

  // TODO: Package into distributable bundle
  console.log("[DownDraft] Export complete (implementation pending)");
}

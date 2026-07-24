export async function build(args: string[]): Promise<void> {
  console.log("[DownDraft] Building game...");

  const target = args.find((a) => !a.startsWith("-")) ?? "current";
  console.log(`[DownDraft] Target: ${target}`);

  // TODO: Bundle + compile for target platform
  console.log("[DownDraft] Build complete (implementation pending)");
}

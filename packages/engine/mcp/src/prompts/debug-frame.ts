import type { PromptRegistration } from "../types";

export function createDebugFramePrompt(): PromptRegistration[] {
  return [
    {
      def: {
        name: "debug-frame",
        description: "Template for debugging why a frame is slow or rendering incorrectly",
        arguments: [
          { name: "symptom", description: "What's wrong (slow, black screen, flickering, etc.)", required: true },
        ],
      },
      handler: (args) => {
        const symptom = args.symptom ?? "the frame is slow";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Debug why ${symptom}.

Steps:
1. Use profile_frame to get per-system timings and frame time
2. Use get_performance_history to see frame time trends
3. Use get_telemetry to check GC pauses, memory, and CPU per thread
4. Use get_scene_tree to verify entity count is expected
5. Use inspect_gpu to check buffer sizes and texture memory
6. If a specific system is slow, use inspect_object to examine related entities
7. Suggest optimizations based on findings`,
              },
            },
          ],
        };
      },
    },
  ];
}

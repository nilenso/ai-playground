import type { BotContext, Plugin } from "../../interfaces/plugin.js";
import type { PluginConfig, PluginConfigSchema } from "../../config/plugin-config.js";
import { logger } from "../../logger.js";

export class LeavePlugin implements Plugin {
    public readonly name = "leave";

    public readonly configSchema: PluginConfigSchema = {
        harvestProjectId: { required: true, description: "Harvest Project ID" },
        harvestVacationTaskId: { required: true, description: "Harvest Vacation Task ID" },
        harvestSickTaskId: { required: true, description: "Harvest Sick Task ID" },
        slackChannelId: { required: false, description: "Channel ID for leave broadcast notifications" }
    };

    public init(ctx: BotContext, config: PluginConfig): void {
        logger.info("Initializing LeavePlugin for Slack events.", { config });

        ctx.slack.onMessage(async (msg) => {
            if (!msg.text) return null;
            const content = msg.text.toLowerCase();

            if (content.includes("leave") || content.includes("vacation") || content.includes("sick")) {
                const response = await ctx.ai.complete({
                    messages: [{ role: "user", content: msg.text }],
                });
                return response.content;
            }
            return null;
        });

        ctx.slack.onAction(/confirm_leave_.*/, async (event) => {
            try {
                await ctx.slack.updateMessage(event.channelId, event.messageTs, {
                    text: `✅ Leave confirmed by <@${event.userId}>. Syncing to Calendar and Harvest...`
                });
            } catch (err) {
                logger.error("Failed to acknowledge leave confirmation", err, { event });
            }
        });
    }

    public stop(): void {
        logger.info("Stopping LeavePlugin.");
    }
}

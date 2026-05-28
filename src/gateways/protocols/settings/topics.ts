import { z } from 'zod';

/**
 * Server-only protocol exposing fetchr's static capabilities.
 * Subscribed snapshots; no client uplink topics.
 */

export enum SettingsServerTopic {
  Plugins = 'plugins',
}

export const SETTINGS_SNAPSHOT_TOPICS = [SettingsServerTopic.Plugins] as const;
export type SettingsSnapshotTopic = (typeof SETTINGS_SNAPSHOT_TOPICS)[number];

const pluginsPayloadSchema = z.object({
  hosts: z.array(
    z.object({
      name: z.string(),
      urlPattern: z.string(),
    }),
  ),
  archives: z.array(z.string()),
});

export type PluginsPayload = z.infer<typeof pluginsPayloadSchema>;

export const settingsServerEventSchema = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal(SettingsServerTopic.Plugins), payload: pluginsPayloadSchema }),
]);

export type SettingsServerEvent<T extends SettingsServerTopic = SettingsServerTopic> = Extract<
  z.infer<typeof settingsServerEventSchema>,
  { topic: T }
>;

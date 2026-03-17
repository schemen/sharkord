import { describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { initTest } from '../../__tests__/helpers';

describe('voice router', () => {
  test('should rate limit excessive voice join attempts', async () => {
    const { caller } = await initTest(1);
    const maxRequests = config.rateLimiters.joinVoiceChannel.maxRequests;

    for (let i = 0; i < maxRequests; i++) {
      await expect(
        caller.voice.join({
          channelId: 999999,
          state: {
            micMuted: false,
            soundMuted: false
          }
        })
      ).rejects.toThrow('Insufficient channel permissions');
    }

    await expect(
      caller.voice.join({
        channelId: 999999,
        state: {
          micMuted: false,
          soundMuted: false
        }
      })
    ).rejects.toThrow('Too many requests. Please try again shortly.');
  });
});

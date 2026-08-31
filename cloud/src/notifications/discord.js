import { config } from '../config.js';

/**
 * Send a Discord webhook notification for a new user signup.
 * Fire-and-forget: errors are logged but never block the caller.
 */
export async function notifyNewUser(user) {
  const webhookUrl = config.discord.webhookUrl;
  if (!webhookUrl) return;

  const embed = {
    title: 'New User Signup',
    color: 0x6366f1,
    thumbnail: user.avatar_url ? { url: user.avatar_url } : undefined,
    fields: [
      {
        name: 'GitHub',
        value: `[@${user.github_login}](https://github.com/${user.github_login})`,
        inline: true,
      },
      {
        name: 'Email',
        value: user.email || 'not provided',
        inline: true,
      },
      {
        name: 'Tier',
        value: user.tier || 'free',
        inline: true,
      },
      {
        name: 'User ID',
        value: `\`${user.id}\``,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: '49Agents' },
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      console.warn(`[discord] Webhook failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[discord] Webhook error: ${err.message}`);
  }
}

/**
 * Send a Discord webhook notification for a new guest session.
 */
export async function notifyGuestUser(user) {
  const webhookUrl = config.discord.webhookUrl;
  if (!webhookUrl) return;

  const embed = {
    title: 'New Guest Session',
    color: 0xf59e0b, // amber
    fields: [
      {
        name: 'Name',
        value: user.display_name || 'Guest',
        inline: true,
      },
      {
        name: 'User ID',
        value: `\`${user.id}\``,
        inline: true,
      },
      {
        name: 'Tier',
        value: user.tier || 'free',
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: '49Agents — Guest Mode' },
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      console.warn(`[discord] Webhook failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[discord] Webhook error: ${err.message}`);
  }
}

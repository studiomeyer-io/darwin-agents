/**
 * Darwin — Notification System
 *
 * Sends alerts when important evolution events happen.
 * Currently supports Telegram. Non-blocking — failures are logged, not thrown.
 *
 * Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID
 */

export interface NotificationConfig {
  telegram?: {
    botToken: string;
    chatId: string;
  };
}

/**
 * Load notification config from environment variables.
 * Returns config with telegram only if both vars are set.
 */
export function loadNotificationConfig(): NotificationConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (botToken && chatId) {
    return { telegram: { botToken, chatId } };
  }

  return {};
}

/**
 * v0.17.0: notify that a challenger is waiting for a human decision.
 *
 * Deliberately more urgent in wording than `notifyEvolutionStarted`: with the
 * approval gate on, NOTHING happens until someone acts, so a message that
 * reads like a status update would let an agent quietly stop evolving.
 */
export async function notifyApprovalRequired(
  config: NotificationConfig,
  agentName: string,
  incumbent: string,
  challenger: string,
  changeReason: string,
  minRuns: number,
): Promise<void> {
  const msg = [
    `⏸️ *Darwin: approval needed*`,
    ``,
    `Agent: \`${agentName}\``,
    `Proposed: *${challenger}* (from ${incumbent})`,
    `Reason: ${changeReason}`,
    ``,
    `No A/B test is running. Nothing changes until you decide.`,
    ``,
    `Approve: \`darwin approve ${agentName}\` (starts ${incumbent} vs ${challenger}, ${minRuns} runs per arm)`,
    `Reject: \`darwin approve ${agentName} --reject\``,
  ].join('\n');

  await sendTelegram(config, msg);
}

/**
 * v0.17.0: notify that a proposal was auto-rejected for want of a decision.
 *
 * The counterpart to {@link notifyABTestTimeout}: a slot that frees itself
 * without a word is invisible to whoever was supposed to decide.
 */
export async function notifyApprovalExpired(
  config: NotificationConfig,
  agentName: string,
  incumbent: string,
  challenger: string,
  budgetDays: number,
): Promise<void> {
  const msg = [
    `⌛ *Darwin: proposal expired*`,
    ``,
    `Agent: \`${agentName}\``,
    `Rejected: ${challenger} (no decision within ${budgetDays}d)`,
    ``,
    `${incumbent} stays active. It was never tested, so nothing was learned about it.`,
    `The next evolution cycle can propose a new challenger.`,
  ].join('\n');

  await sendTelegram(config, msg);
}

/**
 * Notify that an A/B test completed and a winner was activated.
 */
export async function notifyABTestComplete(
  config: NotificationConfig,
  agentName: string,
  winner: string,
  loser: string,
  compositeWinner: number,
  compositeLoser: number,
): Promise<void> {
  const delta = compositeWinner > 0 && compositeLoser > 0
    ? `+${(((compositeWinner - compositeLoser) / compositeLoser) * 100).toFixed(1)}%`
    : '';

  const msg = [
    `🧬 *Darwin A/B Test Complete*`,
    ``,
    `Agent: \`${agentName}\``,
    `Winner: *${winner}* (${compositeWinner.toFixed(3)})`,
    `Loser: ${loser} (${compositeLoser.toFixed(3)}) ${delta}`,
    ``,
    `${winner} is now the active prompt.`,
  ].join('\n');

  await sendTelegram(config, msg);
}

/**
 * Notify that an A/B test was closed by its wall-clock budget
 * (`evolution.maxTestDays`) without ever reaching `minRuns`.
 *
 * Deliberately NOT routed through {@link notifyABTestComplete}: that message
 * announces a winner and a score delta, and a timeout produced neither. The
 * incumbent kept its slot because nothing beat it, not because it won.
 */
export async function notifyABTestTimeout(
  config: NotificationConfig,
  agentName: string,
  incumbent: string,
  challenger: string,
  runsA: number,
  runsB: number,
  minRuns: number,
  maxTestDays: number,
): Promise<void> {
  const msg = [
    `⏱ *Darwin A/B Test Timed Out*`,
    ``,
    `Agent: \`${agentName}\``,
    // "past its Nd budget", not "ran exactly Nd" — the close happens on the
    // first recorded run after expiry, so real elapsed time is at least N.
    `Past its ${maxTestDays}d budget without reaching minRuns (${runsA}/${runsB} of ${minRuns} per arm).`,
    ``,
    `Inconclusive — keeping *${incumbent}*. ${challenger} was NOT promoted.`,
    `The slot is free again for a different challenger.`,
  ].join('\n');

  await sendTelegram(config, msg);
}

/**
 * Notify that a new prompt version was generated and A/B test started.
 */
export async function notifyEvolutionStarted(
  config: NotificationConfig,
  agentName: string,
  oldVersion: string,
  newVersion: string,
  reason: string,
): Promise<void> {
  const msg = [
    `🔬 *Darwin Evolution Started*`,
    ``,
    `Agent: \`${agentName}\``,
    `A/B Test: ${oldVersion} vs *${newVersion}*`,
    `Reason: ${reason.slice(0, 200)}`,
  ].join('\n');

  await sendTelegram(config, msg);
}

/**
 * Notify that a rollback happened.
 */
export async function notifyRollback(
  config: NotificationConfig,
  agentName: string,
  rolledBackTo: string,
  failures: number,
): Promise<void> {
  const msg = [
    `⚠️ *Darwin Rollback*`,
    ``,
    `Agent: \`${agentName}\``,
    `Rolled back to: *${rolledBackTo}*`,
    `After ${failures} consecutive failures`,
  ].join('\n');

  await sendTelegram(config, msg);
}

// ─── Telegram Helper ──────────────────────────────

async function sendTelegram(
  config: NotificationConfig,
  text: string,
): Promise<void> {
  if (!config.telegram) return;

  const { botToken, chatId } = config.telegram;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`[darwin] Telegram notification failed: ${response.status} ${body}`);
    }
  } catch (err) {
    console.warn(`[darwin] Telegram notification error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

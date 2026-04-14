async function sendMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const resolvedChatId = chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !resolvedChatId) {
    console.log("[telegram] Skipping send: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return {
      ok: false,
      skipped: true
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: resolvedChatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  return response.json();
}

module.exports = {
  sendMessage
};

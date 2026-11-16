export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  OWNER_TELEGRAM_ID?: string;
  WEBHOOK_SECRET?: string;
}

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    message?: TelegramMessage;
    from?: { id: number };
  };
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string };
  text?: string;
};

type DraftData = {
  title?: string;
  due_at?: string | null;
  category?: string;
  recurrence?: string | null;
  notes?: string | null;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "lembrei-bot" });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const db = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return json({
        ok: db?.ok === 1,
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.OWNER_TELEGRAM_ID && env.WEBHOOK_SECRET)
      });
    }

    // Tokens stay in headers, never URLs or browser history.
    if (request.method === "POST" && ["/setup-telegram", "/telegram"].includes(url.pathname)) {
      if (!env.WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.OWNER_TELEGRAM_ID) {
        return json({ ok: false, error: "telegram_not_configured" }, 503);
      }
      const supplied = request.headers.get(url.pathname === "/telegram"
        ? "X-Telegram-Bot-Api-Secret-Token" : "Authorization");
      const expected = url.pathname === "/telegram" ? env.WEBHOOK_SECRET : `Bearer ${env.WEBHOOK_SECRET}`;
      if (supplied !== expected) return json({ ok: false, error: "forbidden" }, 403);
      if (url.pathname === "/setup-telegram") {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
          method: "POST", headers: JSON_HEADERS,
          body: JSON.stringify({ url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET,
            allowed_updates: ["message", "callback_query"], drop_pending_updates: false })
        });
        const result = await response.json() as { ok?: boolean };
        return json({ ok: response.ok && result.ok === true }, response.ok && result.ok ? 200 : 502);
      }
      let update: TelegramUpdate;
      try {
        update = await request.json<TelegramUpdate>();
        if (!update || !Number.isSafeInteger(update.update_id)) throw new Error("invalid_update");
      } catch { return json({ ok: false, error: "invalid_update" }, 400); }
      try { return json(await handleTelegramUpdate(update, env)); }
      catch { return json({ ok: false, error: "processing_failed" }, 500); }
    }

    return json({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await sendDueReminders(env);
  }
};

export async function handleTelegramUpdate(update: TelegramUpdate, env: Env) {
  const message = update.message ?? update.callback_query?.message;
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  const chatId = message?.chat.id;
  const rawText = update.callback_query?.data ?? update.message?.text ?? "";

  if (!message || !fromId || !chatId) {
    return { ok: true, ignored: "unsupported_update" };
  }

  if (!env.OWNER_TELEGRAM_ID || String(fromId) !== env.OWNER_TELEGRAM_ID || String(chatId) !== env.OWNER_TELEGRAM_ID) {
    return { ok: true, ignored: "unauthorized" };
  }

  if (await isDuplicate(env.DB, update.update_id)) {
    return { ok: true, duplicate: true };
  }

  const text = rawText.trim();
  const reply = await routeText(env, String(fromId), text);
  await sendTelegramMessage(env, chatId, reply.text, reply.keyboard);
  return { ok: true, reply: reply.text };
}

async function routeText(env: Env, ownerId: string, text: string): Promise<{ text: string; keyboard?: unknown }> {
  const normalized = normalize(text);
  const draft = await getDraft(env.DB, ownerId);

  if (["/cancelar", "cancelar", "sair"].includes(normalized)) {
    await clearDraft(env.DB, ownerId);
    return menu("Operacao cancelada.");
  }

  if (draft && !normalized.startsWith("/")) {
    return continueDraft(env, ownerId, draft, text);
  }

  if (["/start", "start", "/menu", "menu"].includes(normalized)) {
    return menu("Lembrei pronto. Escolha uma acao:");
  }

  if (normalized.startsWith("/novo") || normalized === "novo") {
    const title = text.replace(/^\/?novo/i, "").trim();
    if (title) {
      return createQuickReminder(env, ownerId, title);
    }

    await saveDraft(env.DB, ownerId, "create", null, "title", {});
    return { text: "Qual lembrete voce quer criar?\n\nExemplo: pagar boleto da internet" };
  }

  if (normalized.startsWith("/listar") || normalized === "listar" || normalized === "pendencias") {
    return { text: await listReminders(env.DB, ownerId) };
  }

  if (normalized.startsWith("/concluir") || normalized.startsWith("concluir ")) {
    return { text: await completeReminder(env.DB, ownerId, pickId(text)) };
  }

  if (normalized.startsWith("/excluir") || normalized.startsWith("excluir ")) {
    return { text: await deleteReminder(env.DB, ownerId, pickId(text)) };
  }

  if (normalized.startsWith("/adiar") || normalized.startsWith("adiar ")) {
    return { text: await postponeReminder(env.DB, ownerId, text) };
  }

  if (normalized.startsWith("/editar") || normalized.startsWith("editar ")) {
    return beginEdit(env, ownerId, pickId(text));
  }

  if (normalized.startsWith("/agua") || normalized.startsWith("agua")) {
    return { text: await logWater(env.DB, ownerId, text) };
  }

  if (normalized.startsWith("/categorias") || normalized === "categorias") {
    return { text: await listCategories(env.DB, ownerId) };
  }

  if (normalized.startsWith("/modelo ")) {
    return { text: await saveTemplate(env.DB, ownerId, text) };
  }

  if (normalized.startsWith("/usar ")) {
    return { text: await useTemplate(env.DB, ownerId, text) };
  }

  if (normalized.startsWith("/modelos") || normalized === "modelos") {
    return { text: await listTemplates(env.DB, ownerId) };
  }

  return menu("Nao entendi. Use os botoes ou envie /novo, /listar, /agua.");
}

async function createQuickReminder(env: Env, ownerId: string, input: string) {
  const dateToken = input.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (dateToken && !parseDueDate(dateToken)) return menu("Data invalida. Use AAAA-MM-DD.");
  const parsed = parseReminderInput(input);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO reminders (owner_id, title, category, due_at, recurrence, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(ownerId, parsed.title, parsed.category, parsed.due_at, parsed.recurrence, parsed.notes, now, now)
    .run();

  return menu(`Criado: ${parsed.title}${parsed.due_at ? `\nQuando: ${formatDate(parsed.due_at)}` : ""}`);
}

async function continueDraft(env: Env, ownerId: string, draft: { mode: string; reminder_id: number | null; step: string; data: DraftData }, text: string) {
  const data = draft.data;
  const normalized = normalize(text);

  if (draft.mode === "edit" && draft.reminder_id) {
    if (draft.step === "field") {
      if (!["titulo", "data", "categoria", "recorrencia", "nota"].includes(normalized)) {
        return { text: "O que deseja editar? Responda: titulo, data, categoria, recorrencia ou nota." };
      }
      await saveDraft(env.DB, ownerId, "edit", draft.reminder_id, normalized, data);
      return { text: `Envie o novo valor para ${normalized}. Use "limpar" para remover data/recorrencia/nota.` };
    }

    const value = normalized === "limpar" ? null : text.trim();
    let sql = "";
    if (!value && ["titulo", "categoria"].includes(draft.step)) return { text: "Titulo e categoria nao podem ficar vazios." };
    let bindValue: string | null = value;
    if (draft.step === "titulo") sql = "title = ?";
    if (draft.step === "categoria") sql = "category = ?";
    if (draft.step === "data") {
      sql = "due_at = ?";
      bindValue = value ? parseDueDate(value) : null;
      if (value && !bindValue) return { text: "Data invalida. Use hoje, amanha ou AAAA-MM-DD." };
    }
    if (draft.step === "recorrencia") {
      sql = "recurrence = ?";
      bindValue = value ? parseRecurrence(value) : null;
    }
    if (draft.step === "nota") sql = "notes = ?";
    if (!sql) return menu("Edicao cancelada.");

    await env.DB.prepare(`UPDATE reminders SET ${sql}, updated_at = ? WHERE id = ? AND owner_id = ?`)
      .bind(bindValue, new Date().toISOString(), draft.reminder_id, ownerId)
      .run();
    await clearDraft(env.DB, ownerId);
    return menu("Lembrete atualizado.");
  }

  if (draft.step === "title") {
    data.title = text.trim();
    await saveDraft(env.DB, ownerId, "create", null, "due", data);
    return { text: "Quando devo lembrar? Responda hoje, amanha, uma data AAAA-MM-DD ou pular." };
  }

  if (draft.step === "due") {
    data.due_at = normalized === "pular" ? null : parseDueDate(text);
    if (normalized !== "pular" && !data.due_at) return { text: "Data invalida. Use hoje, amanha, AAAA-MM-DD ou pular." };
    await saveDraft(env.DB, ownerId, "create", null, "category", data);
    return { text: "Qual categoria? Exemplo: casa, trabalho, saude. Pode responder pular." };
  }

  if (draft.step === "category") {
    data.category = normalized === "pular" ? "geral" : sanitizeShort(text);
    await saveDraft(env.DB, ownerId, "create", null, "recurrence", data);
    return { text: "Tem recorrencia? Responda nenhuma, diaria, semanal, mensal ou anual." };
  }

  if (draft.step === "recurrence") {
    data.recurrence = ["nenhuma", "nao", "pular"].includes(normalized) ? null : parseRecurrence(text);
    await saveDraft(env.DB, ownerId, "create", null, "confirm", data);
    return { text: `Confirmar criacao?\n\n${summarizeDraft(data)}\n\nResponda sim ou nao.` };
  }

  if (draft.step === "confirm") {
    if (!["sim", "s", "ok", "confirmar"].includes(normalized)) {
      await clearDraft(env.DB, ownerId);
      return menu("Criacao descartada.");
    }

    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO reminders (owner_id, title, category, due_at, recurrence, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(ownerId, data.title ?? "Lembrete", data.category ?? "geral", data.due_at ?? null, data.recurrence ?? null, data.notes ?? null, now, now)
      .run();
    await clearDraft(env.DB, ownerId);
    return menu("Lembrete criado.");
  }

  await clearDraft(env.DB, ownerId);
  return menu("Fluxo reiniciado.");
}

async function beginEdit(env: Env, ownerId: string, id: number | null) {
  if (!id) return { text: "Informe o numero. Exemplo: /editar 3" };
  const exists = await env.DB.prepare("SELECT id FROM reminders WHERE id = ? AND owner_id = ? AND status != 'deleted'")
    .bind(id, ownerId)
    .first();
  if (!exists) return { text: "Nao encontrei esse lembrete." };
  await saveDraft(env.DB, ownerId, "edit", id, "field", {});
  return { text: "O que deseja editar? Responda: titulo, data, categoria, recorrencia ou nota." };
}

async function listReminders(db: D1Database, ownerId: string) {
  const rows = await db.prepare(
    "SELECT id, title, category, due_at, recurrence FROM reminders WHERE owner_id = ? AND status = 'pending' ORDER BY COALESCE(due_at, '9999-12-31'), id LIMIT 20"
  )
    .bind(ownerId)
    .all<{ id: number; title: string; category: string; due_at: string | null; recurrence: string | null }>();

  if (!rows.results.length) return "Sem pendencias no momento.";
  return rows.results
    .map((r) => `#${r.id} ${r.title}\nCategoria: ${r.category}${r.due_at ? `\nQuando: ${formatDate(r.due_at)}` : ""}${r.recurrence ? `\nRepete: ${r.recurrence}` : ""}`)
    .join("\n\n");
}

async function completeReminder(db: D1Database, ownerId: string, id: number | null) {
  if (!id) return "Informe o numero. Exemplo: /concluir 3";
  const now = new Date().toISOString();
  const reminder = await db.prepare("SELECT recurrence, due_at FROM reminders WHERE id = ? AND owner_id = ? AND status = 'pending'")
    .bind(id, ownerId)
    .first<{ recurrence: string | null; due_at: string | null }>();
  if (!reminder) return "Nao encontrei esse lembrete pendente.";

  if (reminder.recurrence) {
    const next = nextDue(reminder.due_at, reminder.recurrence);
    await db.prepare("UPDATE reminders SET due_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
      .bind(next, now, id, ownerId)
      .run();
    return `Concluido. Reagendei para ${formatDate(next)}.`;
  }

  await db.prepare("UPDATE reminders SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(now, now, id, ownerId)
    .run();
  return "Concluido.";
}

async function deleteReminder(db: D1Database, ownerId: string, id: number | null) {
  if (!id) return "Informe o numero. Exemplo: /excluir 3";
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE reminders SET status = 'deleted', updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(now, id, ownerId)
    .run();
  return result.meta.changes ? "Excluido." : "Nao encontrei esse lembrete.";
}

async function postponeReminder(db: D1Database, ownerId: string, text: string) {
  const id = pickId(text);
  if (!id) return "Informe o numero. Exemplo: /adiar 3 amanha";
  const whenText = text.replace(/^\/?adiar/i, "").replace(String(id), "").trim() || "amanha";
  const due = parseDueDate(whenText);
  if (!due) return "Data invalida. Use hoje, amanha ou AAAA-MM-DD.";
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE reminders SET due_at = ?, postponed_until = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'pending'")
    .bind(due, due, now, id, ownerId)
    .run();
  return result.meta.changes ? `Adiado para ${formatDate(due)}.` : "Nao encontrei esse lembrete pendente.";
}

async function logWater(db: D1Database, ownerId: string, text: string) {
  const amount = Number(text.match(/\d+/)?.[0] ?? 250);
  const safeAmount = Math.max(50, Math.min(amount, 3000));
  await db.prepare("INSERT INTO water_logs (owner_id, amount_ml, logged_at) VALUES (?, ?, ?)")
    .bind(ownerId, safeAmount, new Date().toISOString())
    .run();
  return `Agua registrada: ${safeAmount} ml.`;
}

async function listCategories(db: D1Database, ownerId: string) {
  const rows = await db.prepare("SELECT category, COUNT(*) AS total FROM reminders WHERE owner_id = ? AND status = 'pending' GROUP BY category ORDER BY total DESC")
    .bind(ownerId)
    .all<{ category: string; total: number }>();
  if (!rows.results.length) return "Nenhuma categoria com pendencias.";
  return rows.results.map((r) => `${r.category}: ${r.total}`).join("\n");
}

async function saveTemplate(db: D1Database, ownerId: string, text: string) {
  const body = text.replace(/^\/modelo\s+/i, "").trim();
  const [keyRaw, ...titleParts] = body.split(/\s+/);
  const title = titleParts.join(" ").trim();
  if (!keyRaw || !title) return "Use: /modelo chave texto do lembrete";
  const parsed = parseReminderInput(title);
  await db.prepare(
    "INSERT OR REPLACE INTO templates (owner_id, key, title, category, recurrence, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(ownerId, sanitizeShort(keyRaw), parsed.title, parsed.category, parsed.recurrence, parsed.notes, new Date().toISOString())
    .run();
  return `Modelo salvo: ${sanitizeShort(keyRaw)}`;
}

async function listTemplates(db: D1Database, ownerId: string) {
  const rows = await db.prepare("SELECT key, title, category, recurrence FROM templates WHERE owner_id = ? ORDER BY key LIMIT 20")
    .bind(ownerId)
    .all<{ key: string; title: string; category: string; recurrence: string | null }>();
  if (!rows.results.length) return "Nenhum modelo salvo. Use /modelo chave texto.";
  return rows.results.map((r) => `${r.key}: ${r.title} (${r.category}${r.recurrence ? `, ${r.recurrence}` : ""})`).join("\n");
}

async function useTemplate(db: D1Database, ownerId: string, text: string) {
  const key = sanitizeShort(text.replace(/^\/usar\s+/i, "").trim());
  if (!key) return "Use: /usar chave";
  const t = await db.prepare("SELECT title, category, recurrence, notes FROM templates WHERE owner_id = ? AND key = ?")
    .bind(ownerId, key)
    .first<{ title: string; category: string; recurrence: string | null; notes: string | null }>();
  if (!t) return "Nao encontrei esse modelo.";
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO reminders (owner_id, title, category, recurrence, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(ownerId, t.title, t.category, t.recurrence, t.notes, now, now)
    .run();
  return `Criado pelo modelo: ${t.title}`;
}

async function sendDueReminders(env: Env) {
  if (!env.OWNER_TELEGRAM_ID || !env.TELEGRAM_BOT_TOKEN) return;
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, title, due_at FROM reminders WHERE owner_id = ? AND status = 'pending' AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at LIMIT 10"
  )
    .bind(env.OWNER_TELEGRAM_ID, now)
    .all<{ id: number; title: string; due_at: string }>();
  for (const row of rows.results) {
    await sendTelegramMessage(env, Number(env.OWNER_TELEGRAM_ID), `Lembrete #${row.id}: ${row.title}\nVenceu: ${formatDate(row.due_at)}`);
  }
}

async function sendTelegramMessage(env: Env, chatId: number, text: string, replyMarkup: unknown = mainKeyboard()) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup
    })
  });
  const result = await response.json() as { ok?: boolean };
  if (!response.ok || !result.ok) throw new Error("telegram_send_failed");
}

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "/novo" }, { text: "/listar" }],
      [{ text: "/agua" }, { text: "/categorias" }],
      [{ text: "/modelos" }, { text: "/cancelar" }]
    ],
    resize_keyboard: true
  };
}

function menu(text: string) {
  return { text, keyboard: mainKeyboard() };
}

async function isDuplicate(db: D1Database, updateId: number) {
  const result = await db.prepare("INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)")
    .bind(String(updateId), new Date().toISOString()).run();
  return result.meta.changes === 0;
}

async function getDraft(db: D1Database, ownerId: string) {
  const row = await db.prepare("SELECT mode, reminder_id, step, data FROM drafts WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ mode: string; reminder_id: number | null; step: string; data: string }>();
  return row ? { ...row, data: JSON.parse(row.data) as DraftData } : null;
}

async function saveDraft(db: D1Database, ownerId: string, mode: string, reminderId: number | null, step: string, data: DraftData) {
  await db.prepare("INSERT OR REPLACE INTO drafts (owner_id, mode, reminder_id, step, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ownerId, mode, reminderId, step, JSON.stringify(data), new Date().toISOString())
    .run();
}

async function clearDraft(db: D1Database, ownerId: string) {
  await db.prepare("DELETE FROM drafts WHERE owner_id = ?").bind(ownerId).run();
}

export function parseReminderInput(input: string): Required<Pick<DraftData, "title" | "category">> & Pick<DraftData, "due_at" | "recurrence" | "notes"> {
  const category = input.match(/#([\p{L}\p{N}_-]+)/u)?.[1] ?? "geral";
  const recurrence = input.match(/\b(diaria|diario|semanal|mensal|anual)\b/i)?.[1] ?? null;
  const dueMatch = input.match(/\b(hoje|amanha|\d{4}-\d{2}-\d{2})\b/i)?.[1] ?? null;
  const title = input
    .replace(/#([\p{L}\p{N}_-]+)/gu, "")
    .replace(/\b(diaria|diario|semanal|mensal|anual)\b/gi, "")
    .replace(/\b(hoje|amanha|\d{4}-\d{2}-\d{2})\b/gi, "")
    .trim();

  return {
    title: title || "Lembrete",
    category: sanitizeShort(category),
    due_at: dueMatch ? parseDueDate(dueMatch) : null,
    recurrence: recurrence ? parseRecurrence(recurrence) : null,
    notes: null
  };
}

export function parseDueDate(text: string, base = new Date()): string | null {
  const normalized = normalize(text);
  // Brazilian local date and 09:00, explicitly UTC-03:00 (no runtime-TZ dependency).
  const local = new Date(base.getTime() - 3 * 60 * 60 * 1000);
  let day: string;
  if (normalized === "hoje" || normalized === "amanha") {
    if (normalized === "amanha") local.setUTCDate(local.getUTCDate() + 1);
    day = local.toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) day = normalized;
  else return null;
  const date = new Date(`${day}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return date.toISOString();
}

export function parseRecurrence(text: string) {
  const normalized = normalize(text);
  if (normalized.includes("diar")) return "daily";
  if (normalized.includes("seman")) return "weekly";
  if (normalized.includes("mens")) return "monthly";
  if (normalized.includes("anual")) return "yearly";
  return null;
}

function nextDue(current: string | null, recurrence: string) {
  const date = current ? new Date(current) : new Date();
  if (recurrence === "daily") date.setDate(date.getDate() + 1);
  else if (recurrence === "weekly") date.setDate(date.getDate() + 7);
  else if (recurrence === "monthly") date.setMonth(date.getMonth() + 1);
  else if (recurrence === "yearly") date.setFullYear(date.getFullYear() + 1);
  else date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(9, 0, 0, 0);
  return copy;
}

function pickId(text: string) {
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function sanitizeShort(text: string) {
  return normalize(text).replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "geral";
}

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function summarizeDraft(data: DraftData) {
  return [
    `Titulo: ${data.title ?? "Lembrete"}`,
    `Data: ${data.due_at ? formatDate(data.due_at) : "sem data"}`,
    `Categoria: ${data.category ?? "geral"}`,
    `Recorrencia: ${data.recurrence ?? "nenhuma"}`
  ].join("\n");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo"
  }).format(new Date(value));
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}


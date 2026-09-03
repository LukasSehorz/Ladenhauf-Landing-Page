'use strict';

/**
 * Nimmt die Kurzbewerbung der Landing Page entgegen und stellt sie per Resend
 * als E-Mail zu. Danach geht eine Bestätigung an die bewerbende Person raus.
 *
 * Bewusst ohne npm-Abhängigkeiten: Node 18+ bringt fetch mit, dadurch bleibt
 * die Function ohne package.json und ohne Build-Schritt deploybar.
 *
 * Der Resend-Key steht ausschließlich in process.env.RESEND_API_KEY und darf
 * niemals im Client oder im Repository landen.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAIL_FROM = 'Bewerbungen Kurmittelhaus <bewerbung@svhconsult.de>';
const MAIL_TO = 'lukas.sehorz@svhconsult.de';

/** Bestätigung an die bewerbende Person. Antworten landen beim Team. */
const CONFIRM_FROM = 'Kurmittelhaus der Moderne <bewerbung@svhconsult.de>';
const CONFIRM_REPLY_TO = 'lukas.sehorz@svhconsult.de';

/** Zusage aus der Landingpage. Ändert sie sich dort, muss sie hier mit. */
const ANTWORTZEIT = '24 Stunden';

/** Obergrenze je Feld. Alles darüber wird abgeschnitten. */
const MAX_LEN = 2000;

/** Reihenfolge bestimmt zugleich den Aufbau der E-Mail. */
const FIELDS = [
  { key: 'vorname',   label: 'Vorname',            required: true },
  { key: 'nachname',  label: 'Nachname',           required: true },
  { key: 'email',     label: 'E-Mail',             required: true,  type: 'email' },
  { key: 'telefon',   label: 'Telefon / WhatsApp', required: true,  type: 'tel' },
  { key: 'umfang',    label: 'Gewünschter Umfang', required: true },
  { key: 'erfahrung', label: 'Berufserfahrung',    required: true },
  { key: 'ort',       label: 'Wohnort / PLZ',      required: false },
  { key: 'nachricht', label: 'Nachricht',          required: false, multiline: true }
];

/**
 * Herkunftsdaten aus den versteckten Feldern des Formulars. Niemals Pflicht:
 * eine Bewerbung ohne Kampagnendaten ist eine ganz normale Bewerbung.
 */
const HERKUNFT_FELDER = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'fbclid', 'referrer'
];

/** Kurze Obergrenze, die Werte sind Kampagnenkürzel und keine Fließtexte. */
const HERKUNFT_MAX = 200;

/** Name des Honeypot-Felds im Formular. Menschen sehen es nicht. */
const HONEYPOT = 'webseite';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

/**
 * Entfernt Steuerzeichen. In einzeiligen Feldern werden sie zu Leerzeichen,
 * damit niemand über einen Zeilenumbruch etwas in die Betreffzeile schmuggelt.
 * Bewusst über Zeichencodes statt über Regex-Escapes, das bleibt eindeutig.
 */
function stripControl(input, keepNewlines) {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 10) {                       // Zeilenumbruch
      out += keepNewlines ? '\n' : ' ';
    } else if (code === 13) {                // Wagenrücklauf verwerfen
      continue;
    } else if (code < 32 || code === 127) {  // übrige Steuerzeichen
      out += keepNewlines ? '' : ' ';
    } else {
      out += input.charAt(i);
    }
  }
  return out;
}

/** Vereinheitlicht einen Eingabewert: Steuerzeichen raus, trimmen, kürzen. */
function clean(value, allowNewlines) {
  if (value === null || value === undefined) return '';
  let s = stripControl(String(value), !!allowNewlines);
  if (allowNewlines) {
    // Höchstens eine Leerzeile am Stück, sonst bläht ein Bot die Mail auf.
    s = s.replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/ {2,}/g, ' ');
  }
  s = s.trim();
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** Telefonnummer für tel: auf Ziffern und ein führendes Plus reduzieren. */
function telHref(value) {
  const compact = String(value).replace(/[^\d+]/g, '');
  const plus = compact.charAt(0) === '+' ? '+' : '';
  return plus + compact.replace(/\+/g, '');
}

function berlinTimestamp(date) {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      dateStyle: 'full',
      timeStyle: 'short'
    }).format(date) + ' Uhr';
  } catch (err) {
    return date.toISOString();
  }
}

function json(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

/**
 * Baut die Herkunftszeilen für die interne Mail.
 *
 *   Herkunft: 04-arbeiten-wo-andere-urlaub-machen · fb / feed
 *   Kampagne: LS | 01.09.2026 | Bewerbungen Ergotherapie | Anthojo
 *
 * Ohne Kampagnendaten steht dort "direkt / unbekannt" – eine leere Zeile
 * liesse offen, ob die Herkunft fehlt oder die Auswertung kaputt ist.
 */
function herkunftZeilen(herkunft) {
  const teile = [];
  if (herkunft.utm_content) teile.push(herkunft.utm_content);

  const quelle = [herkunft.utm_source, herkunft.utm_medium].filter(Boolean).join(' / ');
  if (quelle) teile.push(quelle);

  const zeilen = ['Herkunft: ' + (teile.length ? teile.join(' · ') : 'direkt / unbekannt')];
  if (herkunft.utm_campaign) zeilen.push('Kampagne: ' + herkunft.utm_campaign);
  if (herkunft.fbclid) zeilen.push('Klick-ID: ' + herkunft.fbclid);
  if (herkunft.referrer) zeilen.push('Verweis: ' + herkunft.referrer);
  return zeilen;
}

function buildHtml(values, meta) {
  const rows = FIELDS.map(function (f) {
    const raw = values[f.key];
    if (!raw && !f.required) return '';

    let value = escapeHtml(raw);
    if (f.type === 'email') {
      value = '<a href="mailto:' + escapeHtml(raw) + '" style="color:#7F191C;">' + value + '</a>';
    } else if (f.type === 'tel') {
      value = '<a href="tel:' + escapeHtml(telHref(raw)) + '" style="color:#7F191C;">' + value + '</a>';
    } else if (f.multiline) {
      value = value.replace(/\n/g, '<br>');
    }

    return '' +
      '<tr>' +
        '<td style="padding:10px 16px 10px 0;vertical-align:top;color:#5C554A;' +
                   'font:600 13px/1.5 -apple-system,Segoe UI,Arial,sans-serif;white-space:nowrap;">' +
          escapeHtml(f.label) +
        '</td>' +
        '<td style="padding:10px 0;vertical-align:top;color:#1A1714;' +
                   'font:400 15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;">' +
          value +
        '</td>' +
      '</tr>';
  }).join('');

  return '' +
    '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:24px;background:#FAF7F0;">' +
      '<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E7E2D5;' +
                  'border-radius:16px;padding:28px 32px;">' +
        '<h1 style="margin:0 0 4px;color:#17330F;' +
                   'font:600 20px/1.3 -apple-system,Segoe UI,Arial,sans-serif;">' +
          'Neue Bewerbung als Ergotherapeut:in' +
        '</h1>' +
        '<p style="margin:0 0 24px;color:#5C554A;' +
                  'font:400 14px/1.6 -apple-system,Segoe UI,Arial,sans-serif;">' +
          'Kurmittelhaus der Moderne, Bad Reichenhall' +
        '</p>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">' +
          rows +
        '</table>' +
        '<hr style="border:0;border-top:1px solid #E7E2D5;margin:24px 0 16px;">' +
        '<p style="margin:0;color:#5C554A;' +
                  'font:400 13px/1.7 -apple-system,Segoe UI,Arial,sans-serif;">' +
          'Eingegangen am ' + escapeHtml(meta.zeit) + '<br>' +
          'Datenschutz bestätigt: ' + (meta.datenschutz ? 'ja' : 'nein') + '<br>' +
          'Quelle: ' + escapeHtml(meta.quelle) +
        '</p>' +

        // Herkunft bewusst als eigener Block: beim Überfliegen soll sofort
        // klar sein, aus welcher Anzeige die Bewerbung kommt.
        '<div style="margin-top:16px;padding:12px 14px;background:#FAF7F0;' +
                    'border:1px solid #E7E2D5;border-radius:10px;">' +
          '<p style="margin:0;color:#5C554A;word-break:break-word;' +
                    'font:400 13px/1.7 SFMono-Regular,Consolas,monospace;">' +
            herkunftZeilen(meta.herkunft).map(escapeHtml).join('<br>') +
          '</p>' +
        '</div>' +
      '</div>' +
    '</body></html>';
}

function buildText(values, meta) {
  const lines = [
    'Neue Bewerbung als Ergotherapeut:in',
    'Kurmittelhaus der Moderne, Bad Reichenhall',
    ''
  ];
  FIELDS.forEach(function (f) {
    const raw = values[f.key];
    if (!raw && !f.required) return;
    lines.push(f.label + ': ' + raw);
  });
  lines.push('');
  lines.push('Eingegangen am ' + meta.zeit);
  lines.push('Datenschutz bestätigt: ' + (meta.datenschutz ? 'ja' : 'nein'));
  lines.push('Quelle: ' + meta.quelle);
  lines.push('');
  lines.push('--');
  herkunftZeilen(meta.herkunft).forEach(function (zeile) { lines.push(zeile); });
  return lines.join('\n');
}

/* ------------------------------------------------------------------
   Bestätigung an die bewerbende Person

   Bewusst schlicht gehalten: Tabellenlayout und Inline-Styles, weil
   Outlook nichts anderes zuverlässig rendert. Lexend und Open Sans
   stehen nur als Wunsch im Font-Stack, geladen wird in E-Mails nichts –
   deshalb steht dahinter eine vollständige Systemschrift-Kette.
   Keine Anhänge, kein Tracking-Pixel.
   ------------------------------------------------------------------ */

const FONT_STACK = "Lexend,'Open Sans',-apple-system,Segoe UI,Arial,sans-serif";

function buildConfirmHtml(values) {
  const vorname = escapeHtml(values.vorname);

  return '' +
    '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Deine Bewerbung ist angekommen</title></head>' +
    '<body style="margin:0;padding:24px;background:#FAF7F0;">' +
      '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #E7E2D5;' +
                  'border-radius:16px;padding:32px;">' +

        '<h1 style="margin:0 0 20px;color:#7F191C;font:600 22px/1.35 ' + FONT_STACK + ';">' +
          'Deine Bewerbung ist angekommen' +
        '</h1>' +

        '<p style="margin:0 0 16px;color:#1A1714;font:400 16px/1.7 ' + FONT_STACK + ';">' +
          'Hallo ' + vorname + ',' +
        '</p>' +

        '<p style="margin:0 0 16px;color:#1A1714;font:400 16px/1.7 ' + FONT_STACK + ';">' +
          'danke für deine Kurzbewerbung als Ergotherapeut:in bei uns im ' +
          'Kurmittelhaus der Moderne in Bad Reichenhall.' +
        '</p>' +

        '<p style="margin:0 0 24px;color:#1A1714;font:400 16px/1.7 ' + FONT_STACK + ';">' +
          'Wir melden uns innerhalb von <strong style="color:#7F191C;">' + ANTWORTZEIT + '</strong> ' +
          'bei dir.' +
        '</p>' +

        '<p style="margin:0 0 4px;color:#1A1714;font:400 16px/1.7 ' + FONT_STACK + ';">' +
          'Bis gleich' +
        '</p>' +
        '<p style="margin:0;color:#17330F;font:600 16px/1.7 ' + FONT_STACK + ';">' +
          'Dein Team vom Kurmittelhaus der Moderne' +
        '</p>' +

        '<hr style="border:0;border-top:1px solid #E7E2D5;margin:28px 0 16px;">' +
        '<p style="margin:0;color:#5C554A;font:400 13px/1.6 ' + FONT_STACK + ';">' +
          'Deine Angaben nutzen wir ausschließlich für diese Bewerbung.' +
        '</p>' +

      '</div>' +
    '</body></html>';
}

function buildConfirmText(values) {
  return [
    'Hallo ' + values.vorname + ',',
    '',
    'danke für deine Kurzbewerbung als Ergotherapeut:in bei uns im',
    'Kurmittelhaus der Moderne in Bad Reichenhall.',
    '',
    'Wir melden uns innerhalb von ' + ANTWORTZEIT + ' bei dir.',
    '',
    'Bis gleich',
    'Dein Team vom Kurmittelhaus der Moderne',
    '',
    'Deine Angaben nutzen wir ausschließlich für diese Bewerbung.'
  ].join('\n');
}

/**
 * Schickt eine Mail über Resend. Wirft bei Netzwerkfehlern und bei jeder
 * Antwort außerhalb von 2xx, damit beide Fälle oben gleich behandelt werden.
 */
async function sendMail(apiKey, payload) {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const detail = await res.text().catch(function () { return '<Antwort nicht lesbar>'; });
    // Nur ins Function-Log. Der Client erfaehrt bewusst keine Details.
    throw new Error('Resend hat abgelehnt. HTTP ' + res.status + ' ' + detail);
  }

  return await res.json().catch(function () { return {}; });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { ok: false, error: 'invalid_json' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  // Wird später für die Deduplizierung mit der Conversions API gebraucht.
  const eventID = clean(data.eventID, false).slice(0, 64);

  // Honeypot: für Bots sieht der Ablauf erfolgreich aus, es geht aber nichts raus.
  if (clean(data[HONEYPOT], false) !== '') {
    console.log('Honeypot ausgeloest, keine Mail gesendet. eventID=' + (eventID || 'keine'));
    return json(200, { ok: true });
  }

  const values = {};
  const missing = [];
  FIELDS.forEach(function (f) {
    values[f.key] = clean(data[f.key], f.multiline);
    if (f.required && !values[f.key]) missing.push(f.key);
  });

  if (missing.indexOf('email') === -1 && !EMAIL_RE.test(values.email)) {
    missing.push('email');
  }
  if (data.datenschutz !== true) {
    missing.push('datenschutz');
  }

  if (missing.length) {
    return json(400, { ok: false, error: 'validation', fields: missing });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY fehlt. Die Bewerbung konnte nicht zugestellt werden.');
    return json(500, { ok: false, error: 'send_failed' });
  }

  // Herkunft erst nach der Validierung: sie darf nie darüber entscheiden,
  // ob eine Bewerbung angenommen wird.
  const herkunft = {};
  HERKUNFT_FELDER.forEach(function (name) {
    herkunft[name] = clean(data[name], false).slice(0, HERKUNFT_MAX);
  });

  const meta = {
    zeit: berlinTimestamp(new Date()),
    datenschutz: data.datenschutz === true,
    quelle: clean(data.quelle, false) || 'Landingpage Ergotherapie',
    herkunft: herkunft
  };

  // 1. Interne Benachrichtigung. Nur dieser Schritt entscheidet über den Status,
  //    denn er ist die eigentliche Zustellung der Bewerbung.
  try {
    const result = await sendMail(apiKey, {
      from: MAIL_FROM,
      to: [MAIL_TO],
      reply_to: values.email,
      subject: 'Neue Bewerbung Ergotherapie – ' + values.vorname + ' ' + values.nachname,
      html: buildHtml(values, meta),
      text: buildText(values, meta)
    });
    console.log('Bewerbung zugestellt. resendId=' + (result.id || 'unbekannt') +
                ' eventID=' + (eventID || 'keine'));
  } catch (err) {
    console.error('Bewerbung nicht zugestellt: ' + (err && err.message ? err.message : err));
    return json(500, { ok: false, error: 'send_failed' });
  }

  // 2. Bestätigung an die bewerbende Person. Scheitert sie, ist die Bewerbung
  //    trotzdem angekommen – also 200 und der Fehler nur ins Log. Sonst sähe
  //    jemand eine Fehlermeldung und bewirbt sich ein zweites Mal.
  try {
    const confirm = await sendMail(apiKey, {
      from: CONFIRM_FROM,
      to: [values.email],
      reply_to: CONFIRM_REPLY_TO,
      subject: 'Deine Bewerbung ist angekommen – Kurmittelhaus der Moderne',
      html: buildConfirmHtml(values),
      text: buildConfirmText(values)
    });
    console.log('Bestaetigung zugestellt. resendId=' + (confirm.id || 'unbekannt') +
                ' eventID=' + (eventID || 'keine'));
  } catch (err) {
    console.error('Bestaetigung nicht zugestellt (Bewerbung ist trotzdem da): ' +
                  (err && err.message ? err.message : err) +
                  ' eventID=' + (eventID || 'keine'));
  }

  return json(200, { ok: true });
};

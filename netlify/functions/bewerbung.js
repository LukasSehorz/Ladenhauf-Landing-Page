'use strict';

/**
 * Nimmt die Kurzbewerbung der Landing Page entgegen und stellt sie per Resend
 * als E-Mail zu.
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
  return lines.join('\n');
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

  const meta = {
    zeit: berlinTimestamp(new Date()),
    datenschutz: data.datenschutz === true,
    quelle: clean(data.quelle, false) || 'Landingpage Ergotherapie'
  };

  const payload = {
    from: MAIL_FROM,
    to: [MAIL_TO],
    reply_to: values.email,
    subject: 'Neue Bewerbung Ergotherapie – ' + values.vorname + ' ' + values.nachname,
    html: buildHtml(values, meta),
    text: buildText(values, meta)
  };

  try {
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
      console.error('Resend hat abgelehnt. HTTP ' + res.status + ' ' + detail);
      return json(500, { ok: false, error: 'send_failed' });
    }

    const result = await res.json().catch(function () { return {}; });
    console.log('Bewerbung zugestellt. resendId=' + (result.id || 'unbekannt') +
                ' eventID=' + (eventID || 'keine'));
    return json(200, { ok: true });

  } catch (err) {
    console.error('Resend nicht erreichbar: ' + (err && err.message ? err.message : err));
    return json(500, { ok: false, error: 'send_failed' });
  }
};

const DB_ID =
  'ai-studio-lovixassistented-' +
  '4e84b65a-99e3-4d85-' +
  'af2b-a61d76e95421';
const DAY = 86400000;
const OFFERS = {
  '995dutbm': { plano: 'mensal', dias: 30 },
  '9ifk1cly': { plano: 'anual', dias: 365 },
};
const STOP = [
  'PURCHASE_REFUNDED',
  'PURCHASE_CHARGEBACK',
  'PURCHASE_CANCELED',
  'PURCHASE_EXPIRED',
];
const KEEP = {
  PURCHASE_DELAYED: 'atrasado',
  SUBSCRIPTION_CANCELLATION: 'cancelado',
  PURCHASE_PROTEST: 'em_disputa',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) {
    s += String.fromCharCode(b);
  }
  return btoa(s)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const enc = (o) =>
  b64url(
    new TextEncoder().encode(JSON.stringify(o))
  );

async function getToken(sa) {
  const t = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claim = enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com' +
      '/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: t,
    exp: t + 3000,
  });
  const pem = sa.private_key
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(
    atob(pem),
    (c) => c.charCodeAt(0)
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = head + '.' + claim;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(data)
  );
  const r = await fetch(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded',
      },
      body:
        'grant_type=urn%3Aietf%3Aparams%3A' +
        'oauth%3Agrant-type%3Ajwt-bearer' +
        '&assertion=' + data + '.' +
        b64url(sig),
    }
  );
  const j = await r.json();
  if (!j.access_token) throw new Error('token');
  return j.access_token;
}

function root(sa) {
  return (
    'https://firestore.googleapis.com/v1' +
    '/projects/' + sa.project_id +
    '/databases/' + DB_ID + '/documents/'
  );
}

function call(url, tk, opt = {}) {
  return fetch(url, {
    ...opt,
    headers: {
      Authorization: 'Bearer ' + tk,
      'Content-Type': 'application/json',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return json({
        status: 200,
        online: true,
        version: '2.1.0',
        hottokConfigured: !!env.HOTTOK,
        firebaseConfigured:
          !!env.FIREBASE_SERVICE_ACCOUNT,
      });
    }
    if (request.method !== 'POST') {
      return json({ error: 'metodo' }, 405);
    }

    const sent = (
      request.headers.get('x-hotmart-hottok')
      || ''
    ).trim();
    if (!env.HOTTOK || !same(sent, env.HOTTOK)) {
      return json({ error: 'hottok' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: true, ignored: 'json' });
    }

    const event = String(body.event || '').trim();
    const d = body.data || {};
    const email = String(d.buyer?.email || '')
      .trim()
      .toLowerCase();
    const offer = d.purchase?.offer?.code || '';
    const tx = String(
      d.purchase?.transaction || ''
    );
    if (!email || !event) {
      return json({ ok: true, ignored: 'teste' });
    }

    try {
      const sa = JSON.parse(
        env.FIREBASE_SERVICE_ACCOUNT
      );
      const tk = await getToken(sa);
      const base = root(sa);
      const cust =
        base + 'customers/' +
        encodeURIComponent(email);
      const logId = encodeURIComponent(
        (tx || email) + '_' + event
      );

      const dup = await call(
        base + 'events_log/' + logId,
        tk
      );
      if (dup.status === 200) {
        return json({ ok: true, duplicate: true });
      }

      const old = await call(cust, tk);
      let doc = null;
      if (old.status === 200) {
        doc = await old.json();
      } else if (old.status !== 404) {
        throw new Error('read');
      }
      const f = doc?.fields || {};
      const oldExp = f.expira_em?.stringValue;
      const oldPlano = f.plano?.stringValue;

      const now = new Date();
      const off = OFFERS[offer];
      let status = null;
      let exp = oldExp;
      let plano = oldPlano;

      if (event === 'PURCHASE_APPROVED') {
        if (off) {
          status = 'ativo';
          plano = off.plano;
          exp = new Date(
            now.getTime() + off.dias * DAY
          ).toISOString();
        }
      } else if (STOP.includes(event)) {
        if (doc) {
          status = 'inativo';
          exp = now.toISOString();
        }
      } else if (KEEP[event]) {
        if (doc) status = KEEP[event];
      }

      if (status) {
        const fields = {
          email: { stringValue: email },
          plano: {
            stringValue: plano || 'desconhecido',
          },
          status: { stringValue: status },
          expira_em: {
            stringValue:
              exp || now.toISOString(),
          },
          atualizado_em: {
            stringValue: now.toISOString(),
          },
        };
        const w = await call(cust, tk, {
          method: 'PATCH',
          body: JSON.stringify({ fields }),
        });
        if (!w.ok) throw new Error('write');
      }

      await call(
        base + 'events_log?documentId=' + logId,
        tk,
        {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              email: { stringValue: email },
              evento: { stringValue: event },
              transaction: { stringValue: tx },
              aplicado: {
                booleanValue: !!status,
              },
              data: {
                stringValue: now.toISOString(),
              },
            },
          }),
        }
      );

      return json({ ok: true, event, status });
    } catch (err) {
      return json({ error: 'falha' }, 500);
    }
  },
};

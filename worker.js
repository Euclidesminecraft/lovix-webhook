const PROJECT_ID = 'turing-lock-svd6f';
const DAY = 86400000;

const APPS = {
  lovix: {
    kind: 'lovix',
    coll: 'customers',
    db:
      'ai-studio-lovixassistented-' +
      '4e84b65a-99e3-4d85-' +
      'af2b-a61d76e95421',
    offers: {
      '995dutbm': { plan: 'mensal', dias: 30 },
      '9ifk1cly': { plan: 'anual', dias: 365 },
    },
  },
  viki: {
    kind: 'viki',
    coll: 'users',
    db:
      'ai-studio-linguistai-' +
      'a1b91219-4d2d-4d89-' +
      '81e4-e7fcdc588460',
    offers: {
      '9z7r6fwp': { plan: 'monthly', dias: 30 },
      'ogsrgd2d': { plan: 'annual', dias: 365 },
    },
  },
};

const STOP = {
  PURCHASE_REFUNDED: 'refunded',
  PURCHASE_CHARGEBACK: 'chargeback',
  PURCHASE_CANCELED: 'canceled',
  PURCHASE_EXPIRED: 'canceled',
};
const LOVIX_KEEP = {
  PURCHASE_DELAYED: 'atrasado',
  SUBSCRIPTION_CANCELLATION: 'cancelado',
  PURCHASE_PROTEST: 'em_disputa',
};

const s = (v) => ({ stringValue: v });
const b = (v) => ({ booleanValue: v });

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

function same(x, y) {
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) {
    r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return r === 0;
}

async function getToken(env) {
  const r = await fetch(
    'https://identitytoolkit.googleapis.com' +
      '/v1/accounts:signInWithPassword' +
      '?key=' + env.FIREBASE_API_KEY,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: env.WEBHOOK_EMAIL,
        password: env.WEBHOOK_PASSWORD,
        returnSecureToken: true,
      }),
    }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error('login');
  return j.idToken;
}

function root(db) {
  return (
    'https://firestore.googleapis.com/v1' +
    '/projects/' + PROJECT_ID +
    '/databases/' + db + '/documents/'
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

function findApp(offer) {
  for (const key of Object.keys(APPS)) {
    const app = APPS[key];
    if (app.offers[offer]) {
      return { key, app, off: app.offers[offer] };
    }
  }
  return null;
}

function decide(app, off, event, doc, ctx) {
  const { email, tx, now } = ctx;
  const nowIso = new Date(now).toISOString();
  const until = new Date(
    now + off.dias * DAY
  ).toISOString();
  const f = doc?.fields || {};
  const viki = app.kind === 'viki';
  const stored = viki
    ? f.transactionId?.stringValue
    : f.transaction?.stringValue;
  const other = stored && tx && stored !== tx;

  if (event === 'PURCHASE_APPROVED') {
    if (viki) {
      return {
        email: s(email),
        premium: b(true),
        isPremium: b(true),
        status: s('approved'),
        plan: s(off.plan),
        transactionId: s(tx),
        approvedAt: s(nowIso),
        premiumUntil: s(until),
        updatedAt: s(nowIso),
      };
    }
    return {
      email: s(email),
      plano: s(off.plan),
      status: s('ativo'),
      expira_em: s(until),
      transaction: s(tx),
      atualizado_em: s(nowIso),
    };
  }

  if (!doc) return null;

  if (STOP[event]) {
    if (other) return null;
    if (viki) {
      return {
        premium: b(false),
        isPremium: b(false),
        status: s(STOP[event]),
        premiumUntil: s(nowIso),
        updatedAt: s(nowIso),
      };
    }
    return {
      status: s('inativo'),
      expira_em: s(nowIso),
      atualizado_em: s(nowIso),
    };
  }

  if (viki && event === 'PURCHASE_DELAYED') {
    return {
      status: s('pending'),
      updatedAt: s(nowIso),
    };
  }
  if (!viki && LOVIX_KEEP[event]) {
    return {
      status: s(LOVIX_KEEP[event]),
      atualizado_em: s(nowIso),
    };
  }
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return json({
        status: 200,
        online: true,
        version: '3.0.0',
        apps: Object.keys(APPS),
        hottokConfigured: !!env.HOTTOK,
        firebaseConfigured:
          !!env.FIREBASE_API_KEY &&
          !!env.WEBHOOK_EMAIL &&
          !!env.WEBHOOK_PASSWORD,
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

    const hit = findApp(offer);
    if (!hit) {
      return json({ ok: true, ignored: 'oferta' });
    }
    const { key, app, off } = hit;

    try {
      const tk = await getToken(env);
      const base = root(app.db);
      const docUrl =
        base + app.coll + '/' +
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

      const old = await call(docUrl, tk);
      let doc = null;
      if (old.status === 200) {
        doc = await old.json();
      } else if (old.status !== 404) {
        throw new Error('read');
      }

      const now = Date.now();
      const fields = decide(
        app, off, event, doc,
        { email, tx, now }
      );

      if (fields) {
        const mask = Object.keys(fields)
          .map((k) => 'updateMask.fieldPaths=' + k)
          .join('&');
        const w = await call(
          docUrl + '?' + mask,
          tk,
          {
            method: 'PATCH',
            body: JSON.stringify({ fields }),
          }
        );
        if (!w.ok) throw new Error('write');
      }

      await call(
        base + 'events_log?documentId=' + logId,
        tk,
        {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              email: s(email),
              evento: s(event),
              transaction: s(tx),
              aplicado: b(!!fields),
              data: s(new Date(now).toISOString()),
            },
          }),
        }
      );

      return json({
        ok: true,
        app: key,
        event,
        applied: !!fields,
      });
    } catch (err) {
      return json({ error: 'falha' }, 500);
    }
  },
};

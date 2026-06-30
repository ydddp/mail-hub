import type { TemplateProviderConfig } from './template-provider.js';

export interface BuiltinTemplate {
  config: TemplateProviderConfig;
  defaultEnabled?: boolean;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    config: {
      name: 'mailtm',
      displayName: 'Mail.tm',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 1, pollPerMinute: 60 },
      retention: '~days',
      features: { customUsername: true, pollInbox: true, attachments: false },
      apiBase: 'https://api.mail.tm',
      auth: { type: 'none' },
      extraHeaders: { 'Accept': 'application/ld+json' },
      domains: { mode: 'endpoint', path: '/domains', resultPath: 'hydra:member', domainField: 'domain', filter: { field: 'isActive', equals: true } },
      create: { path: '/accounts', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { address: 'address', authData: { accountId: 'id' } }, expiresIn: 86400 },
      postCreate: { path: '/token', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { authData: { token: 'token' } } },
      messages: { path: '/messages', method: 'GET', authFrom: 'inbox', authField: 'token', resultPath: 'hydra:member', itemMapping: { id: 'id', from: 'from.address', subject: 'subject', excerpt: 'intro', receivedAt: 'createdAt' } },
      messageDetail: { path: '/messages/{{messageId}}', method: 'GET', authFrom: 'inbox', authField: 'token', responseMapping: { id: 'id', from: 'from.address', subject: 'subject', text: 'text', html: 'html', receivedAt: 'createdAt' } },
      deleteInbox: { path: '/accounts/{{accountId}}', method: 'DELETE', authFrom: 'inbox', authField: 'token' },
    },
  },
  {
    config: {
      name: 'mailgw',
      displayName: 'Mail.gw',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 20, pollPerMinute: 50 },
      retention: '8 days',
      features: { customUsername: true, pollInbox: true, attachments: false },
      apiBase: 'https://api.mail.gw',
      auth: { type: 'none' },
      extraHeaders: { 'Accept': 'application/ld+json' },
      domains: { mode: 'endpoint', path: '/domains', resultPath: 'hydra:member', domainField: 'domain', filter: { field: 'isActive', equals: true } },
      create: { path: '/accounts', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { address: 'address', authData: { accountId: 'id' } }, expiresIn: 86400 },
      postCreate: { path: '/token', method: 'POST', body: { address: '{{address}}', password: '{{password}}' }, responseMapping: { authData: { token: 'token' } } },
      messages: { path: '/messages', method: 'GET', authFrom: 'inbox', authField: 'token', resultPath: 'hydra:member', itemMapping: { id: 'id', from: 'from.address', subject: 'subject', excerpt: 'intro', receivedAt: 'createdAt' } },
      messageDetail: { path: '/messages/{{messageId}}', method: 'GET', authFrom: 'inbox', authField: 'token', responseMapping: { id: 'id', from: 'from.address', subject: 'subject', text: 'text', html: 'html', receivedAt: 'createdAt' } },
      deleteInbox: { path: '/accounts/{{accountId}}', method: 'DELETE', authFrom: 'inbox', authField: 'token' },
    },
  },
  {
    config: {
      name: 'tempmail-lol',
      displayName: 'TempMail.lol',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 6, pollPerMinute: 10 },
      retention: '1h',
      features: { customUsername: true, pollInbox: true, attachments: false },
      apiBase: 'https://api.tempmail.lol/v2',
      auth: { type: 'none' },
      domains: { mode: 'from_create' },
      create: { path: '/inbox/create', method: 'POST', body: { community: true, prefix: '{{username}}', domain: '{{domain}}' }, responseMapping: { address: 'address', authData: { token: 'token' } }, expiresIn: 3600 },
      messages: { path: '/inbox?token={{token}}', method: 'GET', authFrom: 'inbox', authField: 'token', resultPath: 'emails', itemMapping: { id: 'date', from: 'from', subject: 'subject', excerpt: 'body', receivedAt: 'date', text: 'body', html: 'html' } },
      messageDetail: { fromList: true, path: '', method: 'GET', authFrom: 'inbox', responseMapping: { id: 'date', from: 'from', subject: 'subject', text: 'body', html: 'html', receivedAt: 'date' } },
    },
  },
  {
    config: {
      name: 'tempmail-ing',
      displayName: 'TempMail.ing',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 2, pollPerMinute: 10 },
      retention: '10min',
      features: { customUsername: false, pollInbox: true, attachments: false },
      apiBase: 'https://api.tempmail.ing',
      auth: { type: 'none' },
      domains: { mode: 'from_create' },
      create: { path: '/api/generate', method: 'POST', body: { duration: 10 }, responseMapping: { address: 'email.address', authData: { address: 'email.address' } }, expiresIn: 600 },
      messages: { path: '/api/emails/{{address}}', method: 'GET', authFrom: 'inbox', authField: 'address', resultPath: 'emails', itemMapping: { id: 'id', from: 'from_address', subject: 'subject', excerpt: 'text', receivedAt: 'received_at', text: 'text', html: 'content' } },
      messageDetail: { fromList: true, path: '', method: 'GET', authFrom: 'inbox', responseMapping: { id: 'id', from: 'from_address', subject: 'subject', text: 'text', html: 'content', receivedAt: 'received_at' } },
    },
  },
  {
    // Guerrilla Mail — pure GET query-param API. No auth needed.
    // set_email_user step skipped: TemplateProvider does not support conditional
    // postCreate, so customUsername is off. Random addresses from get_email_address
    // cover the typical use case.
    config: {
      name: 'guerrillamail',
      displayName: 'Guerrilla Mail',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 60, pollPerMinute: 60 },
      retention: '1h',
      features: { customUsername: false, pollInbox: true, attachments: false },
      apiBase: 'https://www.guerrillamail.com/ajax.php',
      auth: { type: 'none' },
      domains: { mode: 'static', list: ['guerrillamailblock.com', 'sharklasers.com'] },
      create: {
        path: '?f=get_email_address',
        method: 'GET',
        responseMapping: { address: 'email_addr', authData: { sid: 'sid_token' } },
        expiresIn: 3600,
      },
      messages: {
        path: '?f=check_email&sid_token={{sid}}&seq=0',
        method: 'GET',
        authFrom: 'provider',
        resultPath: 'list',
        itemMapping: { id: 'mail_id', from: 'mail_from', subject: 'mail_subject', excerpt: 'mail_excerpt', receivedAt: 'mail_date' },
      },
      messageDetail: {
        path: '?f=fetch_email&sid_token={{sid}}&email_id={{messageId}}',
        method: 'GET',
        authFrom: 'provider',
        responseMapping: { id: 'mail_id', from: 'mail_from', subject: 'mail_subject', text: 'mail_text', html: 'mail_body', receivedAt: 'mail_date' },
      },
      deleteInbox: {
        path: '?f=forget_me&sid_token={{sid}}&email_addr={{address}}',
        method: 'GET',
        authFrom: 'provider',
      },
    },
  },
  {
    // Dropmail.me — GraphQL provider. The token is part of the apiBase URL;
    // edit this template's apiBase to insert your own token, then enable.
    // Free token signup: https://dropmail.me/api/
    defaultEnabled: false,
    config: {
      name: 'dropmail',
      displayName: 'Dropmail.me',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 30, pollPerMinute: 30 },
      retention: '10min (auto-renewed)',
      features: { customUsername: false, pollInbox: true, attachments: true },
      apiBase: 'https://dropmail.me/api/graphql/PASTE_YOUR_TOKEN_HERE',
      auth: { type: 'none' },
      domains: {
        mode: 'endpoint',
        path: '',
        method: 'POST',
        body: { query: 'query { domains { name } }' },
        resultPath: 'data.domains',
        domainField: 'name',
      },
      create: {
        path: '',
        method: 'POST',
        body: { query: 'mutation { introduceSession { id expiresAt addresses { address } } }' },
        responseMapping: {
          address: 'data.introduceSession.addresses.0.address',
          authData: { sessionId: 'data.introduceSession.id' },
        },
      },
      messages: {
        path: '',
        method: 'POST',
        body: { query: 'query { session(id: "{{sessionId}}") { mails { id headerSubject headerFrom text html } } }' },
        authFrom: 'provider',
        resultPath: 'data.session.mails',
        itemMapping: {
          id: 'id',
          from: 'headerFrom',
          subject: 'headerSubject',
          excerpt: 'text',
          receivedAt: '',
          text: 'text',
          html: 'html',
        },
      },
      messageDetail: {
        fromList: true,
        path: '',
        method: 'POST',
        authFrom: 'provider',
        responseMapping: { id: 'id', from: 'headerFrom', subject: 'headerSubject', text: 'text', html: 'html', receivedAt: '' },
      },
    },
  },
  {
    // Maildrop.cc — public GraphQL inbox; no auth, no create call.
    // Mailbox is just `<username>@maildrop.cc` and anyone who knows the name can read.
    config: {
      name: 'maildrop',
      displayName: 'Maildrop.cc',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 30, pollPerMinute: 30 },
      retention: '~24h (shared inbox, publicly readable)',
      features: { customUsername: true, pollInbox: true, attachments: false },
      apiBase: 'https://api.maildrop.cc/graphql',
      auth: { type: 'none' },
      domains: { mode: 'static', list: ['maildrop.cc'] },
      create: {
        skip: true,
        path: '',
        method: 'POST',
        responseMapping: { address: '', authData: {} },
      },
      messages: {
        path: '',
        method: 'POST',
        body: { query: 'query { inbox(mailbox:"{{username}}") { id headerfrom subject date } }' },
        authFrom: 'provider',
        resultPath: 'data.inbox',
        itemMapping: { id: 'id', from: 'headerfrom', subject: 'subject', excerpt: 'subject', receivedAt: 'date' },
      },
      messageDetail: {
        path: '',
        method: 'POST',
        body: { query: 'query { message(mailbox:"{{username}}", id:"{{messageId}}") { id headerfrom subject date data html } }' },
        authFrom: 'provider',
        responseMapping: { id: 'data.message.id', from: 'data.message.headerfrom', subject: 'data.message.subject', text: 'data.message.data', html: 'data.message.html', receivedAt: 'data.message.date' },
      },
    },
  },
  {
    // Temp-Mail.io — uses the public-website internal endpoint. No auth, but it's
    // the same endpoint the website itself uses, so they may add captcha/key in the future.
    config: {
      name: 'tempmail-io',
      displayName: 'Temp-Mail.io',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 5, pollPerMinute: 30 },
      retention: '~24h',
      features: { customUsername: false, pollInbox: true, attachments: false },
      apiBase: 'https://api.internal.temp-mail.io',
      auth: { type: 'none' },
      domains: {
        mode: 'endpoint',
        path: '/api/v3/domains',
        resultPath: 'domains',
        domainField: 'name',
        filter: { field: 'type', equals: 'public' },
      },
      create: {
        path: '/api/v3/email/new',
        method: 'POST',
        body: { min_name_length: 10, max_name_length: 10 },
        responseMapping: { address: 'email', authData: { token: 'token' } },
      },
      messages: {
        path: '/api/v3/email/{{address}}/messages',
        method: 'GET',
        authFrom: 'provider',
        itemMapping: { id: 'id', from: 'from', subject: 'subject', excerpt: 'body_text', receivedAt: 'created_at', text: 'body_text', html: 'body_html' },
      },
      messageDetail: {
        fromList: true,
        path: '',
        method: 'GET',
        authFrom: 'provider',
        responseMapping: { id: 'id', from: 'from', subject: 'subject', text: 'body_text', html: 'body_html', receivedAt: 'created_at' },
      },
    },
  },
  {
    // Catchmail.io — pure receive endpoint; no create call needed (any address just works).
    // Rate limit per docs: 1 request/sec/IP. 7-day retention.
    config: {
      name: 'catchmail',
      displayName: 'Catchmail.io',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 30, pollPerMinute: 30 },
      retention: '7 days',
      features: { customUsername: true, pollInbox: true, attachments: true },
      apiBase: 'https://api.catchmail.io',
      auth: { type: 'none' },
      domains: { mode: 'static', list: ['catchmail.io', 'mailistry.com', 'zeppost.com'] },
      create: {
        skip: true,
        path: '',
        method: 'GET',
        responseMapping: { address: '', authData: {} },
      },
      messages: {
        path: '/api/v1/mailbox?address={{address}}',
        method: 'GET',
        authFrom: 'provider',
        resultPath: 'messages',
        itemMapping: { id: 'id', from: 'from', subject: 'subject', excerpt: 'subject', receivedAt: 'date' },
      },
      messageDetail: {
        path: '/api/v1/message/{{messageId}}?mailbox={{address}}',
        method: 'GET',
        authFrom: 'provider',
        responseMapping: { id: 'id', from: 'from', subject: 'subject', text: 'body.text', html: 'body.html', receivedAt: 'date' },
      },
    },
  },
  {
    // NiMail.cn — Chinese-region temp mail, single domain, form-encoded body.
    // applymail registers/extends the mailbox (10 min lifetime), getmails polls.
    config: {
      name: 'nimail-cn',
      displayName: 'NiMail.cn',
      tier: 'free',
      trustLevel: 1,
      rateLimit: { createPerMinute: 10, pollPerMinute: 30 },
      retention: '10min (resets on each request)',
      features: { customUsername: true, pollInbox: true, attachments: false },
      apiBase: 'https://www.nimail.cn',
      auth: { type: 'none' },
      extraHeaders: { 'Origin': 'https://www.nimail.cn', 'Referer': 'https://www.nimail.cn/' },
      domains: { mode: 'static', list: ['nimail.cn'] },
      create: {
        path: '/api/applymail',
        method: 'POST',
        body: { mail: '{{address}}' },
        bodyType: 'form',
        responseMapping: { address: 'user', authData: {} },
        expiresIn: 600,
      },
      messages: {
        path: '/api/getmails',
        method: 'POST',
        body: { mail: '{{address}}', time: '0' },
        bodyType: 'form',
        authFrom: 'provider',
        resultPath: 'mail',
        itemMapping: { id: 'id', from: 'from', subject: 'subject', excerpt: 'text', receivedAt: 'time', text: 'text', html: 'html' },
      },
      messageDetail: {
        fromList: true,
        path: '',
        method: 'POST',
        authFrom: 'provider',
        responseMapping: { id: 'id', from: 'from', subject: 'subject', text: 'text', html: 'html', receivedAt: 'time' },
      },
    },
  },
];

export const BUILTIN_TEMPLATE_NAMES = new Set(BUILTIN_TEMPLATES.map((entry) => entry.config.name));

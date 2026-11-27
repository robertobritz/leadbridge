import { config } from './config.js';
import { ensureFreshAccessToken } from './shopifyOAuth.js';

const REQUEST_TIMEOUT_MS = 15000;

class ShopifyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.details = details;
  }
}

/** Retorna o token valido para a loja: fixo (shpat_ estatico) ou renovado via OAuth. */
async function resolveAccessToken(store) {
  if (store.authMode === 'oauth') {
    return ensureFreshAccessToken(store);
  }
  return store.adminToken;
}

/**
 * Executa uma operacao GraphQL na Admin API.
 * O token vive apenas aqui, no servidor, e nunca aparece em log ou resposta HTTP.
 */
async function adminGraphQL(store, query, variables = {}, attempt = 1) {
  const url = `https://${store.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    const accessToken = await resolveAccessToken(store);
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new ShopifyError('A Shopify nao respondeu dentro do tempo limite de 15s.');
    }
    throw new ShopifyError(`Falha de rede ao chamar a Shopify: ${error.message}`);
  }
  clearTimeout(timeout);

  if (response.status === 401 || response.status === 403) {
    const hint =
      store.authMode === 'oauth'
        ? `Verifique se a autorizacao OAuth da loja "${store.key}" ainda e valida (acesse /oauth/${store.key}/install caso o refresh_token tenha expirado).`
        : 'Verifique se o token do custom app esta correto e se os escopos read_customers e write_customers estao liberados.';
    throw new ShopifyError(`A Shopify recusou o token (401/403). ${hint}`, { httpStatus: response.status });
  }

  if (response.status === 429 && attempt < 3) {
    const wait = 1000 * attempt;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return adminGraphQL(store, query, variables, attempt + 1);
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ShopifyError(`A Shopify retornou uma resposta inesperada (HTTP ${response.status}).`, {
      httpStatus: response.status,
      body: text.slice(0, 500),
    });
  }

  if (Array.isArray(payload.errors) && payload.errors.length) {
    const throttled = payload.errors.some((error) => error.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      return adminGraphQL(store, query, variables, attempt + 1);
    }
    throw new ShopifyError(payload.errors.map((error) => error.message).join(' | '), {
      graphqlErrors: payload.errors,
    });
  }

  return payload.data;
}

/**
 * A Admin API exige telefone em formato E.164. Numeros invalidos fazem a mutation
 * inteira falhar, entao normalizamos aqui e descartamos o que nao da para salvar.
 */
export function normalizePhone(raw, countryCode) {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  digits = digits.replace(/^0+/, '');
  if (!digits) return null;

  if (countryCode) {
    if (digits.startsWith(countryCode) && digits.length > countryCode.length + 7) {
      return `+${digits}`;
    }
    const combined = `${countryCode}${digits}`;
    return combined.length >= 10 && combined.length <= 15 ? `+${combined}` : null;
  }

  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

const FIND_CUSTOMER = `
  query findCustomer($query: String!) {
    customers(first: 1, query: $query) {
      edges {
        node {
          id
          email
          firstName
          lastName
          phone
          tags
        }
      }
    }
  }
`;

const CREATE_CUSTOMER = `
  mutation createCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id tags }
      userErrors { field message }
    }
  }
`;

const UPDATE_CUSTOMER = `
  mutation updateCustomer($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id tags }
      userErrors { field message }
    }
  }
`;

const ADD_TAGS = `
  mutation addTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const SHOP_INFO = `
  query shopInfo {
    shop { name myshopifyDomain primaryDomain { host } }
  }
`;

function escapeSearchValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function isPhoneError(userErrors) {
  return userErrors.some(
    (error) =>
      (Array.isArray(error.field) && error.field.includes('phone')) ||
      /phone/i.test(error.message || ''),
  );
}

function formatUserErrors(userErrors) {
  return userErrors
    .map((error) => {
      const field = Array.isArray(error.field) ? error.field.join('.') : error.field;
      return field ? `${field}: ${error.message}` : error.message;
    })
    .join(' | ');
}

/**
 * Cria o customer ou, se o e-mail ja existir, apenas acrescenta as tags e
 * completa os campos que ainda estiverem vazios. Nunca sobrescreve dado existente.
 */
export async function upsertLead(store, lead) {
  const warnings = [];
  const tags = [...new Set([...(store.defaultTags || []), ...(lead.tags || [])].filter(Boolean))];
  const phone = normalizePhone(lead.phone, store.phoneCountryCode);

  if (lead.phone && !phone) {
    warnings.push('Telefone ignorado: nao foi possivel converter para o formato internacional exigido pela Shopify.');
  }

  const found = await adminGraphQL(store, FIND_CUSTOMER, {
    query: `email:"${escapeSearchValue(lead.email)}"`,
  });
  const existing = found?.customers?.edges?.[0]?.node || null;

  if (existing) {
    const missingTags = tags.filter((tag) => !(existing.tags || []).includes(tag));

    if (missingTags.length) {
      const tagResult = await adminGraphQL(store, ADD_TAGS, { id: existing.id, tags: missingTags });
      const tagErrors = tagResult?.tagsAdd?.userErrors || [];
      if (tagErrors.length) {
        throw new ShopifyError(`Nao foi possivel adicionar as tags: ${formatUserErrors(tagErrors)}`, {
          userErrors: tagErrors,
        });
      }
    } else {
      warnings.push('As tags ja estavam aplicadas neste contato.');
    }

    // Completa somente lacunas do cadastro. Dados ja preenchidos permanecem intactos.
    const patch = { id: existing.id };
    if (!existing.firstName && lead.firstName) patch.firstName = lead.firstName;
    if (!existing.lastName && lead.lastName) patch.lastName = lead.lastName;
    if (!existing.phone && phone) patch.phone = phone;

    if (Object.keys(patch).length > 1) {
      const updated = await adminGraphQL(store, UPDATE_CUSTOMER, { input: patch });
      const updateErrors = updated?.customerUpdate?.userErrors || [];
      if (updateErrors.length) {
        if (isPhoneError(updateErrors) && patch.phone) {
          delete patch.phone;
          warnings.push(`Telefone recusado pela Shopify: ${formatUserErrors(updateErrors)}`);
          if (Object.keys(patch).length > 1) {
            await adminGraphQL(store, UPDATE_CUSTOMER, { input: patch });
          }
        } else {
          warnings.push(`Campos complementares nao atualizados: ${formatUserErrors(updateErrors)}`);
        }
      }
    }

    return {
      action: 'updated',
      customerId: existing.id,
      tagsApplied: missingTags,
      warnings,
      raw: { existingTags: existing.tags || [] },
    };
  }

  const input = {
    email: lead.email,
    tags,
  };
  if (lead.firstName) input.firstName = lead.firstName;
  if (lead.lastName) input.lastName = lead.lastName;
  if (phone) input.phone = phone;

  if (store.marketingConsent) {
    input.emailMarketingConsent = {
      marketingState: 'SUBSCRIBED',
      marketingOptInLevel: 'SINGLE_OPT_IN',
      consentUpdatedAt: new Date().toISOString(),
    };
  }

  let created = await adminGraphQL(store, CREATE_CUSTOMER, { input });
  let userErrors = created?.customerCreate?.userErrors || [];

  // Telefone invalido e o motivo mais comum de recusa: tentamos de novo sem ele
  // para nao perder o lead por causa de um campo secundario.
  if (userErrors.length && isPhoneError(userErrors) && input.phone) {
    warnings.push(`Telefone recusado pela Shopify e removido do cadastro: ${formatUserErrors(userErrors)}`);
    delete input.phone;
    created = await adminGraphQL(store, CREATE_CUSTOMER, { input });
    userErrors = created?.customerCreate?.userErrors || [];
  }

  if (userErrors.length) {
    throw new ShopifyError(`A Shopify recusou a criacao do contato: ${formatUserErrors(userErrors)}`, {
      userErrors,
    });
  }

  const customer = created?.customerCreate?.customer;
  if (!customer?.id) {
    throw new ShopifyError('A Shopify nao retornou o contato criado.');
  }

  return {
    action: 'created',
    customerId: customer.id,
    tagsApplied: tags,
    warnings,
    raw: { tags: customer.tags || [] },
  };
}

export async function testConnection(store) {
  const data = await adminGraphQL(store, SHOP_INFO);
  const shop = data?.shop;
  if (!shop) {
    throw new ShopifyError('A Shopify respondeu sem os dados da loja.');
  }
  return {
    name: shop.name,
    myshopifyDomain: shop.myshopifyDomain,
    primaryDomain: shop.primaryDomain?.host || null,
    apiVersion: config.shopifyApiVersion,
  };
}

export { ShopifyError };

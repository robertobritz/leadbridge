/* ============================================================================
   INTEGRAÇÃO COM O LEAD BRIDGE
   ----------------------------------------------------------------------------
   Substitua a função submitToShopifyCustomerForm() atual do entry-modal.js
   por esta. Ela envia o lead para o Lead Bridge, que grava o contato na
   Shopify via Admin API. Falhas são silenciosas de propósito: o fluxo do
   HubSpot e do cupom nunca deve ser interrompido por causa desta chamada.

   A URL e a key da loja vêm de data-attributes no <dialog>, então a mesma
   versão deste arquivo funciona em BR, MX e AR sem edição.
   ============================================================================ */

function submitToLeadBridge(dialog, { email, firstname, lastname, phone, tag }) {
  try {
    const endpoint = (dialog.dataset.leadBridgeUrl || '').trim();
    const storeKey = (dialog.dataset.leadBridgeStore || '').trim();

    // Sem configuração no tema a integração fica inativa, sem quebrar nada.
    if (!endpoint || !storeKey) return;

    const payload = {
      storeKey,
      email,
      firstName: firstname || '',
      lastName: lastname || '',
      phone: phone || '',
      tags: [tag],
      website: '', // campo isca: mantenha sempre vazio
    };

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // conclui o envio mesmo se a página for fechada logo depois
    }).catch(() => {
      /* silencioso por design */
    });
  } catch (error) {
    /* silencioso por design */
  }
}

/* ----------------------------------------------------------------------------
   Dentro do listener do submitBtn, troque a chamada antiga
   submitToShopifyCustomerForm({...}) por esta, logo após calcular
   firstname / lastname / phoneForHubSpot:
   ---------------------------------------------------------------------------- */

// submitToLeadBridge(dialog, {
//   email,
//   firstname,
//   lastname,
//   phone: phoneForHubSpot,
//   tag: 'pop-up-entrada',
// });

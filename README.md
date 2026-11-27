# Shopify Lead Bridge

Ponte entre um formulário customizado do tema Shopify e a Admin API. O popup envia o lead,
esta aplicação grava o contato em **Customers** com a tag desejada, e tudo fica registrado
num painel de gestão com histórico.

Resolve o bloqueio de `Missing CAPTCHA token`: a criação do contato acontece pela Admin API
autenticada, não pelo endpoint público `/contact`.

```
Popup do tema  ──POST──▶  Lead Bridge  ──Admin API──▶  Shopify Customers
(navegador)               (servidor)                    (contato + tag)
                              │
                              └──▶ SQLite: histórico visível no painel
```

O token da Shopify vive **apenas no servidor**. Nada sensível vai para o navegador.

---

## Sumário

1. [O que você vai precisar](#1-o-que-você-vai-precisar)
2. [Criar o custom app em cada loja](#2-criar-o-custom-app-em-cada-loja)
3. [Rodar na sua máquina](#3-rodar-na-sua-máquina)
4. [Publicar na Hostinger (VPS)](#4-publicar-na-hostinger-vps)
5. [Integrar no tema](#5-integrar-no-tema)
6. [Validar a integração](#6-validar-a-integração)
7. [Adicionar a segunda loja](#7-adicionar-a-segunda-loja)
8. [Segurança](#8-segurança)
9. [LGPD e consentimento](#9-lgpd-e-consentimento)
10. [Solução de problemas](#10-solução-de-problemas)
11. [Limites conhecidos](#11-limites-conhecidos)

---

## 1. O que você vai precisar

- Node.js 18.17 ou superior (`node -v` para conferir)
- Acesso de admin nas lojas Shopify, para criar o custom app
- Um VPS na Hostinger (ou outro provedor) com acesso root via SSH, Ubuntu 22.04+ recomendado

---

## 2. Criar o custom app em cada loja

Repita para **cada loja** que vai usar a integração.

1. No admin da Shopify: **Settings → Apps and sales channels → Develop apps**
2. **Allow custom app development** (se for a primeira vez) → **Create an app**
3. Nome: `Lead Bridge` → **Create app**
4. Aba **Configuration → Admin API integration → Configure**
5. Marque exatamente estes escopos:
   - `read_customers`
   - `write_customers`
6. **Save** → aba **API credentials** → **Install app**
7. Em **Admin API access token**, clique em **Reveal token once** e copie

> O token começa com `shpat_` e só aparece **uma vez**. Guarde num gerenciador de senhas.
> Se perder, é preciso desinstalar e reinstalar o app para gerar outro.

Anote também o domínio interno da loja (`Settings → Domains`), no formato
`sua-loja.myshopify.com`. É ele que a aplicação usa, não o domínio público.

---

## 3. Rodar na sua máquina

```bash
cd shopify-lead-bridge
npm install
```

Gere um segredo de sessão:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Crie o arquivo `.env` a partir do exemplo:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
PORT=3000
NODE_ENV=development
ADMIN_USER=admin
ADMIN_PASSWORD=uma-senha-longa-e-unica
SESSION_SECRET=cole-aqui-o-segredo-gerado-acima
SHOPIFY_API_VERSION=2026-01
RETENTION_DAYS=90
```

Para desenvolvimento local, configure as lojas num arquivo separado (mais legível que JSON
em uma linha). Copie o exemplo e preencha:

```bash
cp stores.example.json stores.json
```

```json
[
  {
    "key": "madesa-mx",
    "label": "Madesa México",
    "shopDomain": "madesa-mx.myshopify.com",
    "adminToken": "shpat_o-token-da-loja-mx",
    "allowedOrigins": ["https://madesa.mx"],
    "defaultTags": ["pop-up-entrada"],
    "phoneCountryCode": "52",
    "marketingConsent": false
  }
]
```

| Campo | Obrigatório | Para que serve |
|---|---|---|
| `key` | sim | Identificador usado pelo tema. Minúsculas, números e hífen |
| `shopDomain` | sim | Domínio `.myshopify.com` da loja |
| `adminToken` | sim | Token do custom app |
| `allowedOrigins` | sim | Domínios do site autorizados a enviar leads |
| `label` | não | Nome exibido no painel |
| `defaultTags` | não | Tags aplicadas sempre, independente do que o tema enviar |
| `phoneCountryCode` | não | Prefixo usado quando o telefone chega sem `+` |
| `marketingConsent` | não | `true` marca o contato como inscrito em e-mail marketing |

> `stores.json` e `.env` já estão no `.gitignore`. Nunca comite esses arquivos.

### 3.1 Alternativa: renovação automática de token via OAuth

Desde dezembro/2025 a Shopify oferece **expiring offline tokens**: em vez de um `shpat_`
estático (que nunca expira), você recebe um `access_token` de curta duração (tipicamente
~1h) mais um `refresh_token` (válido por 90 dias) usado para gerar novos `access_token` sem
precisar reautorizar o app manualmente. Isso é opcional — use apenas se a loja exigir isso,
ou se preferir tokens de vida curta por segurança. Uma loja com adminToken estático continua
funcionando normalmente.

Para usar, troque o campo `adminToken` da loja por um bloco `oauth` em `stores.json` (ou no
`STORES_CONFIG`), com o **client ID** e a **client secret** (`shpss_...`) do app no
Dev Dashboard / Partner Dashboard:

```json
{
  "key": "madesa-mx",
  "label": "Madesa México",
  "shopDomain": "madesa-mx.myshopify.com",
  "oauth": {
    "clientId": "o-client-id-do-app",
    "clientSecret": "shpss_a-client-secret-do-app",
    "scopes": ["read_customers", "write_customers"]
  },
  "allowedOrigins": ["https://madesa.mx"],
  "defaultTags": ["pop-up-entrada"],
  "phoneCountryCode": "52",
  "marketingConsent": false
}
```

Defina também no `.env`:

```env
APP_URL=https://seu-dominio.com
TOKEN_ENCRYPTION_KEY=64-caracteres-hex-gerados-com-node--crypto
```

Gere a `TOKEN_ENCRYPTION_KEY` com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Importante:** a Shopify não permite gerar um `access_token` só com `client_id` +
`client_secret`. É preciso um consentimento único do merchant (fluxo OAuth "authorization
code grant"), feito pelo navegador. Depois desse passo único, a aplicação renova o token
sozinha, sem intervenção humana. Para autorizar:

1. Cadastre `https://seu-dominio.com/oauth/<key>/callback` (e, em dev,
   `http://localhost:3000/oauth/<key>/callback`) como **Allowed redirection URL(s)** do app,
   no Dev/Partner Dashboard.
2. Suba a aplicação e entre no painel (`/admin`) com o usuário e senha do `.env`.
3. Acesse `/oauth/<key>/install` (autenticado) — por exemplo,
   `http://localhost:3000/oauth/madesa-mx/install` — e aprove as permissões na tela da
   Shopify.
4. A aplicação salva o `refresh_token` criptografado (AES-256-GCM) no SQLite e passa a
   renovar o `access_token` sozinha: proativamente pouco antes de cada vencimento, e também
   numa rotina extra de segurança às 03:00 todos os dias. Se o `refresh_token` expirar (90
   dias sem uso) ou for revogado, repita o passo 3.

Suba a aplicação:

```bash
npm start
```

Abra `http://localhost:3000/admin`, entre com o usuário e senha do `.env` e clique em
**Testar conexão** no card da loja. Se aparecer o nome da loja em verde, o token está certo.

---

## 4. Publicar na Hostinger (VPS)

Você está usando um **VPS da Hostinger com a conta da empresa** — servidor próprio, sempre
ativo, sem hibernação e sem os limites de plano gratuito. O disco é persistente por padrão,
então o histórico do painel sobrevive normalmente a reinicializações e atualizações.

A diferença para uma hospedagem tipo Render é que aqui você tem acesso root a uma máquina
Linux, então quem mantém o processo no ar, o HTTPS e o firewall é você — não a plataforma.
O roteiro abaixo cobre isso.

### 4.1 Acessar o VPS

No painel da Hostinger (hPanel → VPS), pegue o IP do servidor e a senha root, ou configure
uma chave SSH (recomendado). Depois:

```bash
ssh root@SEU_IP_AQUI
```

### 4.2 Preparar o servidor (uma vez só)

```bash
apt update && apt upgrade -y

# Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Nginx: faz o HTTPS e expõe a aplicação na porta 443 sem abrir a porta 3000 pra fora
apt install -y nginx

# Firewall: só SSH, HTTP e HTTPS ficam acessíveis de fora
apt install -y ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

Confirme as versões:

```bash
node -v   # precisa ser 18.17 ou superior
npm -v
```

### 4.3 Criar um usuário próprio para a aplicação

Rodar como root o tempo todo não é necessário e não é uma boa prática. Crie um usuário
dedicado:

```bash
adduser leadbridge
usermod -aG sudo leadbridge
su - leadbridge
```

Todo o resto do deploy roda como esse usuário.

### 4.4 Enviar o projeto para o servidor

Duas formas, escolha a que for mais prática pra você:

**Opção A — via Git** (melhor se você já versiona o projeto):

```bash
git clone https://github.com/sua-conta/shopify-lead-bridge.git
cd shopify-lead-bridge
```

**Opção B — via SCP**, direto da sua máquina, sem precisar de repositório:

```bash
# Rode este comando na SUA máquina, não no servidor
scp -r shopify-lead-bridge leadbridge@SEU_IP_AQUI:/home/leadbridge/
```

### 4.5 Instalar e configurar

Dentro da pasta do projeto, no servidor:

```bash
npm install --omit=dev
mkdir -p data
```

Gere o segredo de sessão:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Crie o `.env`:

```bash
nano .env
```

```env
PORT=3000
NODE_ENV=production
TRUST_PROXY=1
ADMIN_USER=admin
ADMIN_PASSWORD=uma-senha-longa-e-unica
SESSION_SECRET=cole-aqui-o-segredo-gerado-acima
SHOPIFY_API_VERSION=2026-01
DB_PATH=/home/leadbridge/shopify-lead-bridge/data/leads.db
RETENTION_DAYS=90
STORES_CONFIG=[{"key":"madesa-mx","label":"Madesa México","shopDomain":"madesa-mx.myshopify.com","adminToken":"shpat_aaa","allowedOrigins":["https://madesa.mx"],"defaultTags":["pop-up-entrada"],"phoneCountryCode":"52"},{"key":"madesa-br","label":"Madesa Brasil","shopDomain":"totvsrs-madesa.myshopify.com","adminToken":"shpat_bbb","allowedOrigins":["https://madesa.com"],"defaultTags":["pop-up-entrada"],"phoneCountryCode":"55"}]
```

`Ctrl+O` para salvar, `Ctrl+X` para sair. Como o servidor é próprio (não uma plataforma
gerenciada), o `TRUST_PROXY=1` é necessário aqui porque o Nginx fica na frente da aplicação
como proxy reverso.

Confirme que `.env` não fica visível para outros usuários do sistema:

```bash
chmod 600 .env
```

### 4.6 Colocar a aplicação no ar com systemd

O `systemd` já vem instalado em qualquer VPS Linux — não precisa instalar nada extra. Ele
cumpre a mesma função de manter a aplicação viva (reinicia sozinho se cair, sobe sozinho se
o servidor reiniciar), com um único arquivo de configuração.

Crie o arquivo do serviço (como root, ou com `sudo`):

```bash
sudo nano /etc/systemd/system/lead-bridge.service
```

```ini
[Unit]
Description=Shopify Lead Bridge
After=network.target

[Service]
Type=simple
User=leadbridge
WorkingDirectory=/home/leadbridge/shopify-lead-bridge
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/leadbridge/shopify-lead-bridge/.env

[Install]
WantedBy=multi-user.target
```

Dois pontos que merecem atenção nesse arquivo:

- **`User=leadbridge`** garante que o processo roda com o usuário dedicado da seção 4.3,
  não como root.
- **`Restart=on-failure`** é o que resolve o problema original: se a aplicação travar por
  qualquer motivo, o systemd sobe ela de novo automaticamente, sem precisar de ninguém
  entrando no servidor pra reiniciar na mão.

Confirme o caminho do Node, que pode variar conforme a instalação:

```bash
which node
```

Se o caminho for diferente de `/usr/bin/node`, ajuste o `ExecStart` no arquivo acima antes
de continuar.

Ative e inicie o serviço:

```bash
sudo systemctl daemon-reload
sudo systemctl enable lead-bridge
sudo systemctl start lead-bridge
```

O `enable` é o que garante que a aplicação sobe sozinha se o VPS reiniciar — não precisa de
nenhum comando adicional depois disso, diferente de ferramentas como o PM2.

Teste local, ainda dentro do servidor:

```bash
curl http://localhost:3000/health
```

Deve responder `{"ok":true,"stores":2,"environment":"production"}`.

Comandos do dia a dia:

```bash
sudo systemctl status lead-bridge    # ver se está rodando
sudo systemctl restart lead-bridge   # aplicar mudanças no .env ou no código
sudo systemctl stop lead-bridge      # parar a aplicação
```

Se algum dia você precisar olhar os logs pelo terminal (o painel cobre o dia a dia, mas em
caso de um problema mais profundo pode ajudar):

```bash
sudo journalctl -u lead-bridge -f
```

### 4.7 Apontar o domínio e configurar o Nginx

No painel da Hostinger (ou onde o DNS do domínio estiver gerenciado), crie um registro
`A` apontando um subdomínio para o IP do VPS, por exemplo:

```
leads.madesa.com  →  A  →  SEU_IP_AQUI
```

De volta ao servidor (como root, ou com `sudo`), crie o site no Nginx:

```bash
sudo nano /etc/nginx/sites-available/lead-bridge
```

```nginx
server {
    listen 80;
    server_name leads.madesa.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Ative e recarregue:

```bash
sudo ln -s /etc/nginx/sites-available/lead-bridge /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4.8 HTTPS com Let's Encrypt

O popup do tema chama a API por `fetch()` a partir de uma página `https://`, então o
endpoint **precisa** ser `https://` também — navegador nenhum permite passar de HTTPS para
HTTP nessa chamada (mixed content). Configure o certificado:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d leads.madesa.com
```

O Certbot edita o bloco do Nginx sozinho para redirecionar HTTP → HTTPS e renova o
certificado automaticamente antes de vencer.

### 4.9 Conferir

```bash
curl https://leads.madesa.com/health
```

Acesse `https://leads.madesa.com/admin`, entre com o usuário e senha do `.env`, e rode
**Testar conexão** em cada loja.

A URL que vai para o `data-lead-bridge-url` no tema é esta:

```
https://leads.madesa.com/api/lead
```

### 4.10 Backup do histórico

O histórico vive num único arquivo SQLite. Um backup diário simples, copiando para fora do
VPS, é suficiente. Exemplo de rotina com `cron`, mantendo os últimos 14 dias localmente:

```bash
crontab -e
```

```
0 3 * * * cp /home/leadbridge/shopify-lead-bridge/data/leads.db /home/leadbridge/backups/leads-$(date +\%Y\%m\%d).db && find /home/leadbridge/backups -mtime +14 -delete
```

Crie a pasta antes: `mkdir -p /home/leadbridge/backups`. Para uma camada extra de segurança,
sincronize essa pasta de backups para fora do servidor (outro serviço de armazenamento, por
exemplo) periodicamente — assim um problema no VPS não leva o histórico junto.

### 4.11 Atualizando o código depois

```bash
cd /home/leadbridge/shopify-lead-bridge
git pull            # ou reenviar via scp
npm install --omit=dev
sudo systemctl restart lead-bridge
```

---

## 5. Integrar no tema

### 5.1 `snippets/entry-modal.liquid`

Adicione dois data-attributes na tag `<dialog data-entry-modal>`, junto dos que já existem:

```liquid
data-lead-bridge-url="https://leads.madesa.com/api/lead"
data-lead-bridge-store="madesa-mx"
```

Fica assim (trecho):

```liquid
<dialog
  class="entry-modal-new"
  data-entry-modal
  data-entry-coupon-code="{{ settings.custom_popup_coupon_code | escape }}"
  data-entry-delay="{{ settings.custom_popup_delay_time | times: 1000 }}"
  data-hs-portal-id="39596724"
  data-hs-form-id="4e89b582-6e3f-4170-83e0-733983b236a0"
  data-lead-bridge-url="https://leads.madesa.com/api/lead"
  data-lead-bridge-store="madesa-mx"
  ...
>
```

Manter a URL e a key no liquid permite usar o **mesmo** `entry-modal.js` nas duas lojas,
trocando só o valor de `data-lead-bridge-store`.

### 5.2 `assets/entry-modal.js`

**Substitua** a função `submitToShopifyCustomerForm()` (a que postava para `/contact`) por esta:

```javascript
function submitToLeadBridge(dialog, { email, firstname, lastname, phone, tag }) {
  try {
    const endpoint = (dialog.dataset.leadBridgeUrl || '').trim();
    const storeKey = (dialog.dataset.leadBridgeStore || '').trim();

    // Sem configuração no tema a integração fica inativa, sem quebrar nada.
    if (!endpoint || !storeKey) return;

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeKey,
        email,
        firstName: firstname || '',
        lastName: lastname || '',
        phone: phone || '',
        tags: [tag],
        website: '',
      }),
      keepalive: true,
    }).catch(() => {
      /* silencioso por design */
    });
  } catch (error) {
    /* silencioso por design */
  }
}
```

E dentro do listener do `submitBtn`, **troque a chamada antiga** por esta, logo depois de
calcular `firstname` / `lastname` / `phoneForHubSpot`:

```javascript
submitToLeadBridge(dialog, {
  email,
  firstname,
  lastname,
  phone: phoneForHubSpot,
  tag: 'pop-up-entrada',
});
```

O `phoneForHubSpot` já vem em formato internacional (`+55...`), que é exatamente o que a
Admin API exige. Reaproveitar esse valor evita um segundo formatador no tema.

A chamada continua sendo disparada em paralelo e falhando em silêncio: o fluxo do HubSpot e
a aplicação do cupom nunca são interrompidos por causa dela.

---

## 6. Validar a integração

Faça o teste no **preview do tema fora do Theme Editor** (aba normal, sem iframe).

Antes de cada rodada, limpe o estado do popup no console:

```javascript
localStorage.removeItem('entry_modal_completed');
localStorage.removeItem('entry_modal_dismissed_at');
localStorage.removeItem('entry_modal_pending_coupon_code');
```

Depois recarregue a página ou abra o popup direto com `window.openEntryModal()`.

Cheque estes cenários:

| # | Teste | Onde conferir |
|---|---|---|
| 1 | E-mail novo | Shopify → Customers: contato criado com nome, telefone e a tag |
| 2 | Mesmo e-mail de novo | O contato **não** duplica; a tag continua uma só |
| 3 | E-mail de cliente que já existe | A tag é adicionada sem apagar as tags antigas |
| 4 | Qualquer envio | Painel → Histórico: registro com resultado **Gravado** |
| 5 | HubSpot | Contato criado como antes, sem regressão |

No painel, clique em qualquer linha do histórico para ver o payload recebido, a resposta da
Shopify, avisos e o link direto para o contato no admin.

Para conferir o endpoint sem passar pelo popup:

```bash
curl -i -X POST https://leads.madesa.com/api/lead \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://madesa.mx' \
  -d '{"storeKey":"madesa-mx","email":"teste@example.com","firstName":"Teste","lastName":"Bridge","phone":"+5215512345678","tags":["pop-up-entrada"]}'
```

Resposta esperada: `200` com `{"ok":true,"action":"created"}`.

---

## 7. Adicionar a segunda loja

1. Crie o custom app na nova loja (passo 2) e copie o token
2. Acrescente um objeto no `STORES_CONFIG` com uma `key` nova
3. Reinicie o serviço na hospedagem
4. No tema da nova loja, adicione os dois data-attributes com a `key` correspondente

Nenhuma alteração de código é necessária. O painel passa a mostrar a nova loja e o filtro
por loja fica disponível no histórico.

---

## 8. Segurança

O que já está implementado:

- **Token só no servidor.** Nunca é enviado ao navegador, nem aparece em logs ou na API do
  painel. O painel mostra apenas os 4 últimos caracteres, para conferência visual.
- **Allowlist de origem por loja.** Requisições de domínios não cadastrados recebem `403`.
- **Limite de requisições.** 30 envios por IP a cada 10 minutos no endpoint público; 10
  tentativas de login a cada 15 minutos.
- **Corpo limitado a 16 KB** e validação estrita de todos os campos.
- **Deduplicação.** O mesmo e-mail processado com sucesso nos últimos 60 segundos é ignorado.
- **Campo isca** para descartar preenchimento automatizado.
- **Painel protegido** por login com cookie assinado (HttpOnly, SameSite=Lax, Secure em
  produção) e comparação de senha em tempo constante.
- **IP não é gravado em texto puro**, apenas um hash.
- **Cabeçalhos de segurança** e Content-Security-Policy restritiva. O painel não carrega
  nenhum recurso externo.
- **Erros detalhados ficam no painel**, não na resposta pública.

Cuidados que dependem de você:

- Use uma `ADMIN_PASSWORD` longa e exclusiva, e um `SESSION_SECRET` aleatório de 64+ caracteres
- Mantenha o repositório **privado** e nunca comite `.env` nem `stores.json`
- Se um token for exposto, desinstale o custom app na Shopify e gere outro
- Revise os acessos ao painel da hospedagem, que é onde as variáveis ficam visíveis

Sobre um limite estrutural, para ficar claro: o endpoint `/api/lead` é chamado pelo
JavaScript do tema, que roda no navegador do visitante. Não existe segredo possível nesse
contexto — qualquer chave embutida no tema seria pública. A `storeKey` é um **identificador**,
não uma senha. As proteções acima reduzem abuso, mas não autenticam o visitante.

Se em algum momento você precisar de autenticação real na origem, o caminho é o
**App Proxy** da Shopify: as requisições passam a ser assinadas com HMAC pela própria
Shopify e a aplicação valida a assinatura. Exige criar um app, então fica como evolução
futura, não como requisito inicial.

---

## 9. LGPD e consentimento

- `marketingConsent` é `false` por padrão. O contato é criado **sem** opt-in de e-mail
  marketing. Só ative se o texto do popup deixar o consentimento explícito.
- O histórico guarda nome, e-mail e telefone, porque é isso que permite auditar e reenviar.
  `RETENTION_DAYS` apaga registros antigos automaticamente (90 dias por padrão).
- O IP é armazenado apenas como hash, nunca em texto puro.

---

## 10. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `403` no `/api/lead` | Domínio fora do `allowedOrigins` | Inclua o domínio exato, com `https://` e sem barra final |
| `400 Loja não reconhecida` | `data-lead-bridge-store` diferente da `key` | Confira se os dois valores batem |
| Painel acusa token recusado | Token errado ou escopos faltando | Revise `read_customers` e `write_customers`; reinstale o app se necessário |
| Contato criado sem telefone | Shopify recusou o número | Abra o registro no painel: o aviso mostra o motivo. O lead é salvo mesmo assim |
| Histórico some depois de reiniciar | `DB_PATH` aponta para um caminho temporário | Confirme que `DB_PATH` está dentro da pasta do projeto no VPS, não em `/tmp` |
| Aplicação não reinicia sozinha após reboot do VPS | Serviço não habilitado no systemd | Rode `sudo systemctl enable lead-bridge` e confirme com `sudo systemctl is-enabled lead-bridge` |
| Aplicação não sobe depois de mudar o `.env` | Serviço não foi reiniciado | Rode `sudo systemctl restart lead-bridge` — o systemd só relê o `.env` ao reiniciar |
| Nada chega no painel | Chamada nem sai do tema | Aba Network do DevTools, filtro `lead`: confira se a requisição aparece |
| `A Shopify não respondeu` | Instabilidade ou timeout | Use **Reenviar para a Shopify** no painel |

Erro de validação na inicialização (`[config] ...`) significa variável de ambiente ausente
ou malformada. A mensagem indica exatamente qual campo corrigir.

---

## 11. Limites conhecidos

- **Não substitui o envio ao HubSpot.** O `entry-modal.js` continua enviando direto para a
  Forms API, preservando `hubspotutk` e IP. Esta ponte cuida apenas do lado Shopify.
- **Sem retentativa automática.** Falhas ficam registradas e o reenvio é manual pelo painel.
  Se o volume de falhas crescer, o próximo passo é uma fila com retentativa.
- **SQLite depende de backup.** No VPS o disco já é persistente, então isso não é um risco
  de perda no dia a dia — mas vale manter a rotina de backup da seção 4.10 para o caso de
  um problema no próprio servidor. Para volume muito alto ou várias instâncias, o caminho é
  migrar para Postgres.
- **Um login só.** O painel tem um único usuário. Se mais pessoas precisarem acessar, o
  próximo passo é usuários separados.
- **Nome vem quebrado em dois campos** pela lógica do tema (`splitFullName`). Nomes compostos
  vão inteiros para o sobrenome, comportamento igual ao que já existe no HubSpot hoje.

---

## Referência rápida

| Rota | Acesso | Função |
|---|---|---|
| `POST /api/lead` | Público, com allowlist | Recebe o lead do tema |
| `GET /health` | Público | Checagem de disponibilidade |
| `GET /admin` | Requer login | Painel |
| `GET /admin/login` | Público | Tela de acesso |

Estrutura do projeto:

```
src/
  server.js          Aplicação Express e cabeçalhos de segurança
  config.js          Leitura e validação das variáveis e lojas
  db.js              SQLite: histórico, estatísticas e retenção
  shopify.js         Admin API: busca, criação, tags e telefone
  auth.js            Login do painel e sessão assinada
  routes/lead.js     Endpoint público
  routes/admin.js    API do painel
  public/            Telas de login e painel
theme/
  entry-modal-integration.js   Código para colar no tema
```
editei aqui
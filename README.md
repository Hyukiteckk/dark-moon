# Dark Moon

Ferramenta de utilidades para Discord.

## Requisitos

- [Node.js 18+](https://nodejs.org)
- [Discord](https://discord.com) com [BetterDiscord](https://betterdiscord.app) (para os plugins)

## Instalação

```bash
# 1. Clone o repositório
git clone https://github.com/Hyukiteckk/dark-moon.git
cd dark-moon

# 2. Instale as dependências
npm install

# 3. Configure o bot de aprovação
cp desktop/config.example.json desktop/config.json
```

Abra o `desktop/config.json` e preencha com os seus dados:

```json
{
  "BOT_SERVICE_URL": "https://seu-worker.seu-subdominio.workers.dev",
  "BOT_SECRET": "a-chave-secreta-do-seu-worker"
}
```

> Se não tiver um Worker próprio, peça ao administrador a URL e a chave.

## Rodar

```bash
npm start
```

## Bot de aprovação (Cloudflare Worker)

O sistema de cadastro usa um Worker no Cloudflare (gratuito). Para configurar o seu próprio:

1. Crie uma conta em [cloudflare.com](https://cloudflare.com)
2. Siga as instruções em [`bot-service/`](bot-service/)

## Compilar

```bash
npm run build:win
```

O executável é gerado na pasta `dist/`.

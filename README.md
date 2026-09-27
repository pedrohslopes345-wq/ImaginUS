# ImaginUS

Toques combinados entre duas pessoas, no PC.

- Cada mensagem ("Oi", "Saudade"…) tem um significado e um som curto.
- Clique numa mensagem para enviar, ou use o atalho global (padrão **Ctrl + Alt + Espaço**) para enviar a mensagem marcada com ★.
- O PC da outra pessoa toca o som, **sem notificação do Windows**. Tudo fica registrado só no **Dash** (data, horário e significado).
- O app fica ao lado do relógio, abre com o Windows e **se atualiza sozinho** pelo GitHub.

---

## 1. Configurar o Firebase (uma vez, uns 10 minutos)

É o servidor gratuito que guarda contas, mensagens, sons e o Dash. **Não precisa de cartão.**

1. Entre em <https://console.firebase.google.com> → **Criar projeto** (pode desativar o Google Analytics).
2. **Authentication** → Começar → **E-mail/senha** → Ativar → Salvar.
3. **Firestore Database** → Criar banco de dados → local **`southamerica-east1 (São Paulo)`** → modo de produção.
4. Ainda no Firestore, aba **Regras**: apague tudo, cole o conteúdo de [`firebase/firestore.rules`](firebase/firestore.rules) e clique em **Publicar**.
5. ⚙ **Configurações do projeto** → "Seus apps" → ícone **`</>`** (Web) → dê um nome → Registrar.
   Copie o objeto `firebaseConfig` que aparece e cole em [`src/renderer/firebase-config.js`](src/renderer/firebase-config.js).

## 2. Rodar no seu PC (desenvolvimento)

```bash
npm install
npm start
```

**Testar sozinho:** abra uma segunda cópia com login separado (janela "ImaginUS (teste)") e faça o papel das duas pessoas:

```bash
npm run start:teste
```

Para ver só a interface com dados de mentira, sem Firebase: abra `renderer/index.html#demo` servido por qualquer servidor local.

## 3. Primeiro uso

1. Cada pessoa cria a própria conta no app (nome, e-mail, senha).
2. Uma pessoa clica em **Gerar meu código**, a outra digita esse código em **Vincular** (vale 15 minutos).
3. Pronto: aparece a mensagem "Oi". Crie outras com **+ Nova** e escolha um som (até 10 s / 800 KB).
4. Clique com o botão direito numa mensagem (ou no **⋯**) para ouvir, editar, excluir ou colocar no atalho.
5. Em **Ajustes**: trocar o atalho, ligar "Abrir junto com o Windows".

Mensagem sem som próprio toca um bipe padrão.

---

## 4. Atualização automática

O app procura versões novas no **GitHub Releases** ao abrir e a cada 4 horas. Quando acha, baixa escondido e:
- mostra "Versão X pronta — Reiniciar e atualizar" no topo do app e no menu do ícone;
- se ninguém clicar, instala sozinha quando o app fecha (ex.: ao desligar o PC).

### ⚠️ O repositório precisa ser público

O app baixa as atualizações sem senha, então os *Releases* precisam estar num repositório **público**. Duas opções:

- **Mais simples:** deixar `ImaginUS` público (GitHub → Settings → Danger Zone → Change visibility). Não há segredo no código: a configuração do Firebase é pública por natureza e quem protege os dados são as regras do Firestore.
- **Manter o código privado:** crie um segundo repositório público só para as versões (ex.: `ImaginUS-releases`) e troque o `"repo"` em `package.json` → `build.publish`.

### Publicar uma versão nova

1. Crie um token no GitHub (uma vez): <https://github.com/settings/tokens> → *Fine-grained token* → acesso só ao repositório das versões → permissão **Contents: Read and write**.
2. Guarde o token numa variável de ambiente do Windows chamada `GH_TOKEN` (Painel de Controle → "Editar as variáveis de ambiente para sua conta"). Abra um terminal novo depois disso.
3. A cada versão:
   ```bash
   npm version patch --no-git-tag-version
   npm run release
   ```
   O primeiro comando sobe a versão no `package.json` (0.1.0 → 0.1.1). O segundo gera o instalador e publica no GitHub. Os dois PCs se atualizam sozinhos.

### Primeira instalação

```bash
npm run dist
```

Gera `dist/ImaginUS Setup 0.1.0.exe`. Mande esse arquivo **uma única vez** para a outra pessoa. Na primeira execução o Windows mostra "O Windows protegeu o computador" porque o app não tem certificado pago: clique em **Mais informações → Executar assim mesmo**. As atualizações seguintes não mostram esse aviso.

---

## Estrutura

| Caminho | O que é |
|---|---|
| `src/main.js` | Processo principal: janela, ícone na bandeja, atalho global, abrir com o Windows, atualização automática |
| `src/preload.js` | Ponte segura entre a interface e o processo principal |
| `src/renderer/app.js` | Toda a lógica da interface: login, vínculo, mensagens, sons, Dash |
| `src/renderer/firebase-config.js` | Configuração do seu projeto Firebase |
| `renderer/` | HTML e CSS da interface (o `app.bundle.js` é gerado pelo `npm run build`) |
| `firebase/firestore.rules` | Regras de segurança: só vocês dois leem e escrevem os dados do par |
| `scripts/make-icons.js` | Gera os ícones (`npm run icons`) |

## Limites conhecidos

- Toques que chegam com o PC desligado (ou há mais de 2 minutos) **não tocam**; aparecem no Dash com um ponto de "novo".
- O atalho não pode ser só **Ctrl + Alt**: no Windows isso é a tecla AltGr. Use Ctrl + Alt + alguma tecla.

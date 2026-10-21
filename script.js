// ============================================================
// AUDITORIA SHOPPING - SCRIPT PRINCIPAL
// Compatível com Android 6.0.1 Marshmallow
// Login offline + fila de sincronização + Excel Avançado
// ============================================================

// --- CONFIGURAÇÕES GLOBAIS ---
const DOMINIO_FICTICIO = "@tacaruna.com.br";
const USUARIO_ADMIN = "diegofilipe";

// --- LISTA DE LOJAS FIXA NO CÓDIGO ---
const LOJAS = [
    "Aby's",
    "Hering Kids",
    "Nel Blu",
    "Ecológica",
    "Grandão do Queijo",
    "Mundo Verde"
];

// --- ESTADO GLOBAL ---
let usuarioLogado = null;
let lojaSelecionada = null;
let fluxoDocIdHoje = null;
let exportacaoOrigem = 'lojas';
let sincronizandoAgora = false;

// Variáveis de controle da Tela de Vendas
let vendaGeneroSelecionado = null;
let vendaIdadeSelecionada = null;
let vendaItensCount = 1;

// ============================================================
// SISTEMA DE LOGIN OFFLINE (cache de credenciais)
// ============================================================
const CRED_KEY = 'auditoria_credenciais';
const SESSAO_KEY = 'auditoria_sessao_offline';

async function hashSenha(texto) {
    if (window.crypto && window.crypto.subtle) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(texto);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.warn("crypto.subtle falhou, usando fallback:", e);
        }
    }
    let hash = 0;
    for (let i = 0; i < texto.length; i++) {
        hash = ((hash << 5) - hash) + texto.charCodeAt(i);
        hash = hash & hash;
    }
    return 'fb_' + Math.abs(hash).toString(16);
}

function lerCredenciais() {
    try {
        const txt = localStorage.getItem(CRED_KEY);
        return txt ? JSON.parse(txt) : {};
    } catch (e) {
        return {};
    }
}

async function salvarCredencial(usuario, senha) {
    try {
        const creds = lerCredenciais();
        const hash = await hashSenha(senha);
        creds[usuario.toLowerCase()] = {
            hash: hash,
            ultimoLogin: new Date().toISOString()
        };
        localStorage.setItem(CRED_KEY, JSON.stringify(creds));
    } catch (e) {
        console.error("Erro ao salvar credencial:", e);
    }
}

async function validarCredencialOffline(usuario, senha) {
    const creds = lerCredenciais();
    const u = usuario.toLowerCase();
    if (!creds[u]) return false;
    const hash = await hashSenha(senha);
    return creds[u].hash === hash;
}

function salvarSessaoOffline(usuario) {
    try {
        localStorage.setItem(SESSAO_KEY, JSON.stringify({
            usuario: usuario,
            data: new Date().toISOString()
        }));
    } catch (e) {}
}

function lerSessaoOffline() {
    try {
        const txt = localStorage.getItem(SESSAO_KEY);
        return txt ? JSON.parse(txt) : null;
    } catch (e) {
        return null;
    }
}

function removerSessaoOffline() {
    try {
        localStorage.removeItem(SESSAO_KEY);
    } catch (e) {}
}

function temCredenciaisSalvas() {
    const creds = lerCredenciais();
    return Object.keys(creds).length > 0;
}

function ehErroDeRede(error) {
    if (!error) return false;
    const code = error.code || '';
    return code === 'auth/network-request-failed' ||
           code === 'auth/internal-error' ||
           !estaOnline();
}

// ============================================================
// SISTEMA DE FILA OFFLINE
// ============================================================
const FILA_KEY = 'auditoria_fila_sync';

function lerFila() {
    try {
        const txt = localStorage.getItem(FILA_KEY);
        return txt ? JSON.parse(txt) : [];
    } catch (e) {
        console.error("Erro ao ler fila:", e);
        return [];
    }
}

function salvarFila(fila) {
    try {
        localStorage.setItem(FILA_KEY, JSON.stringify(fila));
        atualizarIndicadorFila();
    } catch (e) {
        console.error("Erro ao salvar fila:", e);
    }
}

function gerarIdUnico(item) {
    const data = item.dataHoraLocal || new Date().toISOString();
    const lojaLimpa = (item.loja || '').replace(/[^a-zA-Z0-9]/g, '');
    const auditorLimpo = (item.auditor || '').replace(/[^a-zA-Z0-9]/g, '');
    const dataLimpa = data.replace(/[^0-9]/g, '');
    let hash = 0;
    const seed = JSON.stringify(item);
    for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash) + seed.charCodeAt(i);
        hash = hash & hash;
    }
    const hashStr = Math.abs(hash).toString(36).substr(0, 6);
    return item.tipo + '_' + lojaLimpa + '_' + auditorLimpo + '_' + dataLimpa + '_' + hashStr;
}

function adicionarNaFila(item) {
    const fila = lerFila();
    item._localId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    item._dataLocal = new Date().toISOString();
    if (!item._docId) {
        item._docId = gerarIdUnico(item);
    }
    fila.push(item);
    salvarFila(fila);
    return item._localId;
}

function removerDaFila(localId) {
    let fila = lerFila();
    fila = fila.filter(i => i._localId !== localId);
    salvarFila(fila);
}

function atualizarIndicadorFila() {
    const fila = lerFila();
    const qtd = fila.length;
    const indicador = document.getElementById('indicador-fila');
    if (!indicador) return;

    if (qtd === 0) {
        indicador.style.display = 'none';
    } else {
        indicador.style.display = 'inline-block';
        indicador.textContent = qtd;
        indicador.title = qtd + ' item(ns) aguardando sincronização';
    }
}

function estaOnline() {
    return navigator.onLine !== false;
}

// ============================================================
// SINCRONIZAÇÃO COM TRAVA
// ============================================================
async function sincronizarFila(silencioso) {
    if (sincronizandoAgora) return;

    if (!estaOnline()) return;

    if (!auth.currentUser && lerSessaoOffline()) {
        if (silencioso) return;
        const sessao = lerSessaoOffline();
        const senha = prompt("Digite sua senha para sincronizar (" + sessao.usuario + "):");
        if (!senha) return;

        try {
            const emailFake = sessao.usuario + DOMINIO_FICTICIO;
            await auth.signInWithEmailAndPassword(emailFake, senha);
            usuarioLogado = sessao.usuario;
            await salvarCredencial(sessao.usuario, senha);
        } catch (err) {
            console.error("Falha ao reautenticar:", err);
            alert("Não foi possível reautenticar. Verifique a senha.");
            return;
        }
    }

    if (!auth.currentUser) return;

    const fila = lerFila();
    if (fila.length === 0) {
        atualizarStatusConexao();
        return;
    }

    sincronizandoAgora = true;
    console.log("🔒 Trava ativada. Sincronizando " + fila.length + " item(ns)...");

    for (let i = 0; i < fila.length; i++) {
        const item = fila[i];
        try {
            const dados = Object.assign({}, item);
            const docId = dados._docId;
            delete dados._localId;
            delete dados._dataLocal;
            delete dados._docId;

            if (dados.dataHoraLocal) {
                dados.dataHora = firebase.firestore.Timestamp.fromDate(new Date(dados.dataHoraLocal));
                delete dados.dataHoraLocal;
            } else if (!dados.dataHora) {
                dados.dataHora = firebase.firestore.FieldValue.serverTimestamp();
            }

            await db.collection('registros').doc(docId).set(dados, { merge: false });
            removerDaFila(item._localId);
        } catch (err) {
            console.error("✗ Erro ao sincronizar item:", err);
        }
    }

    sincronizandoAgora = false;
    console.log("🔓 Trava liberada.");
    atualizarStatusConexao();
    if (typeof atualizarInfoPainelAdmin === 'function') atualizarInfoPainelAdmin();
}

async function salvarComFila(dados, docId) {
    const itemParaFila = Object.assign({}, dados);
    itemParaFila.dataHoraLocal = new Date().toISOString();
    if (docId) itemParaFila._docId = docId;

    if (estaOnline() && auth.currentUser) {
        try {
            const dadosEnvio = Object.assign({}, dados);
            dadosEnvio.dataHora = firebase.firestore.FieldValue.serverTimestamp();

            if (docId) {
                await db.collection('registros').doc(docId).set(dadosEnvio, { merge: true });
            } else {
                await db.collection('registros').add(dadosEnvio);
            }
            return { ok: true, offline: false };
        } catch (err) {
            console.warn("Falha ao enviar, adicionando à fila:", err);
            adicionarNaFila(itemParaFila);
            return { ok: true, offline: true };
        }
    } else {
        adicionarNaFila(itemParaFila);
        return { ok: true, offline: true };
    }
}

window.addEventListener('online', () => {
    atualizarStatusConexao();
    setTimeout(sincronizarFila, 500);
});

window.addEventListener('offline', () => {
    atualizarStatusConexao();
});

function atualizarStatusConexao() {
    const el = document.getElementById('status-conexao');
    const elOff = document.getElementById('sessao-offline-aviso');

    if (el) el.style.display = estaOnline() ? 'none' : 'block';

    if (elOff) {
        const semAuth = !auth.currentUser && lerSessaoOffline();
        elOff.style.display = (semAuth && estaOnline()) ? 'block' : 'none';
    }
}

// ============================================================
// NAVEGAÇÃO
// ============================================================
function mostrarTela(idTela) {
    document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa'));
    document.getElementById(idTela).classList.add('ativa');
}

function ehAdmin() {
    return usuarioLogado && usuarioLogado.toLowerCase() === USUARIO_ADMIN.toLowerCase();
}

// ============================================================
// REGISTRAR LOGIN NO FIREBASE
// ============================================================
async function registrarLogin(usuario) {
    if (!estaOnline() || !auth.currentUser) return;
    try {
        await db.collection('logins').add({
            usuario: usuario,
            dataHora: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error("Erro ao registrar login:", error);
    }
}

// ============================================================
// LOGIN (COM SUPORTE OFFLINE)
// ============================================================
async function fazerLogin() {
    const usuario = document.getElementById('login-usuario').value.trim().toLowerCase();
    const senha = document.getElementById('login-senha').value.trim();
    const erroEl = document.getElementById('login-erro');
    const btnEntrar = document.querySelector('#tela-login .btn-primario');

    if (!usuario || !senha) {
        erroEl.textContent = "Preencha usuário e senha.";
        return;
    }

    btnEntrar.textContent = "Entrando...";
    btnEntrar.disabled = true;
    erroEl.textContent = "";

    // CASO 1: SEM INTERNET
    if (!estaOnline()) {
        const valido = await validarCredencialOffline(usuario, senha);
        if (valido) {
            usuarioLogado = usuario;
            salvarSessaoOffline(usuario);
            carregarLojas();
            mostrarTela('tela-lojas');
            document.getElementById('login-usuario').value = "";
            document.getElementById('login-senha').value = "";
            atualizarStatusConexao();
            atualizarIndicadorFila();
            btnEntrar.textContent = "Entrar";
            btnEntrar.disabled = false;
            return;
        } else {
            if (temCredenciaisSalvas()) {
                erroEl.textContent = "Sem internet. Usuário ou senha incorretos.";
            } else {
                erroEl.textContent = "Sem internet. Faça o primeiro login conectado.";
            }
            btnEntrar.textContent = "Entrar";
            btnEntrar.disabled = false;
            return;
        }
    }

    // CASO 2: COM INTERNET - Firebase
    const emailFake = usuario + DOMINIO_FICTICIO;

    try {
        const cred = await auth.signInWithEmailAndPassword(emailFake, senha);
        usuarioLogado = cred.user.email.split('@')[0];

        await salvarCredencial(usuario, senha);
        salvarSessaoOffline(usuarioLogado);

        registrarLogin(usuarioLogado);
        carregarLojas();
        mostrarTela('tela-lojas');
        document.getElementById('login-usuario').value = "";
        document.getElementById('login-senha').value = "";

        setTimeout(sincronizarFila, 1500);

    } catch (error) {
        console.error("Erro no login:", error);

        if (ehErroDeRede(error)) {
            const valido = await validarCredencialOffline(usuario, senha);
            if (valido) {
                usuarioLogado = usuario;
                salvarSessaoOffline(usuario);
                carregarLojas();
                mostrarTela('tela-lojas');
                document.getElementById('login-usuario').value = "";
                document.getElementById('login-senha').value = "";
                atualizarStatusConexao();
                atualizarIndicadorFila();
                btnEntrar.textContent = "Entrar";
                btnEntrar.disabled = false;
                return;
            }
            erroEl.textContent = "Falha de conexão. Verifique a internet.";
        } else if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
            erroEl.textContent = "Usuário ou senha incorretos.";
        } else if (error.code === 'auth/too-many-requests') {
            erroEl.textContent = "Muitas tentativas. Aguarde.";
        } else {
            erroEl.textContent = "Erro ao entrar. Tente novamente.";
        }
    } finally {
        btnEntrar.textContent = "Entrar";
        btnEntrar.disabled = false;
    }
}

function fazerLogout() {
    removerSessaoOffline();
    if (estaOnline() && auth.currentUser) {
        auth.signOut().catch(err => console.warn("Erro ao sair:", err));
    }
    usuarioLogado = null;
    lojaSelecionada = null;
    fluxoDocIdHoje = null;
    mostrarTela('tela-login');
}

// ============================================================
// SELEÇÃO DE LOJA
// ============================================================
function carregarLojas() {
    const container = document.getElementById('lista-lojas');
    container.innerHTML = "";
    LOJAS.forEach(loja => {
        const div = document.createElement('div');
        div.className = 'card-loja';
        div.textContent = loja;
        div.onclick = () => selecionarLoja(loja);
        container.appendChild(div);
    });

    const btnExportar = document.getElementById('btn-exportar');
    if (btnExportar) {
        btnExportar.style.display = ehAdmin() ? 'inline-block' : 'none';
    }

    atualizarIndicadorFila();
    atualizarStatusConexao();
    if (typeof atualizarPainelAdmin === 'function') atualizarPainelAdmin();
}

function selecionarLoja(loja) {
    lojaSelecionada = loja;
    document.getElementById('nome-loja-header').textContent = loja;
    document.getElementById('nome-auditor-header').textContent = 'Auditor: ' + usuarioLogado;
    mostrarTela('tela-principal');
    mudarAba('vendas');
    fluxoDocIdHoje = null;
    carregarFluxoHoje();
    atualizarIndicadorFila();
    atualizarStatusConexao();
}

function voltarParaLojas() {
    lojaSelecionada = null;
    mostrarTela('tela-lojas');
    atualizarIndicadorFila();
    atualizarStatusConexao();
}

function mudarAba(aba) {
    document.querySelectorAll('.aba').forEach(b => b.classList.remove('ativa'));
    document.getElementById('aba-' + aba).classList.add('ativa');
    document.querySelectorAll('.conteudo-aba').forEach(c => c.classList.remove('ativa'));
    document.getElementById('conteudo-' + aba).classList.add('ativa');
}

// ============================================================
// TELA DE VENDAS - CONTROLES VISUAIS
// ============================================================
function alterarVendaContador(idElemento, valor) {
    if (idElemento === 'venda-itens') {
        vendaItensCount += valor;
        if (vendaItensCount < 1) vendaItensCount = 1;
        document.getElementById('venda-itens').textContent = vendaItensCount;
    }
}

function selecionarGenero(gen) {
    vendaGeneroSelecionado = gen;
    document.getElementById('btn-gen-m').classList.remove('selecionado');
    document.getElementById('btn-gen-f').classList.remove('selecionado');
    if (gen === 'Masculino') document.getElementById('btn-gen-m').classList.add('selecionado');
    if (gen === 'Feminino') document.getElementById('btn-gen-f').classList.add('selecionado');
}

function selecionarIdade(idade) {
    vendaIdadeSelecionada = idade;
    for (let i = 1; i <= 4; i++) document.getElementById('btn-idade-' + i).classList.remove('selecionado');
    const map = { 'Até 19 anos': 1, 'De 20 a 29 anos': 2, 'De 30 a 44 anos': 3, '45 ou mais': 4 };
    if (map[idade]) document.getElementById('btn-idade-' + map[idade]).classList.add('selecionado');
}

// ============================================================
// SALVAR VENDA
// ============================================================
async function salvarVenda() {
    const valor = document.getElementById('venda-valor').value;
    const cupom = document.getElementById('venda-cupom').checked;
    const pagamento = document.getElementById('venda-pagamento').value;
    const obs = document.getElementById('venda-obs').value;
    const troca = document.getElementById('venda-troca').checked;
    const virada = document.getElementById('venda-virada').checked;

    if (!valor || !pagamento) {
        alert("Preencha o Valor e a Forma de Pagamento.");
        return;
    }
    if (!vendaGeneroSelecionado || !vendaIdadeSelecionada) {
        alert("Por favor, selecione o Gênero e a Faixa Etária.");
        return;
    }

    const valorNumerico = parseFloat(valor);
    if (isNaN(valorNumerico) || valorNumerico <= 0) {
        alert("Valor inválido. Digite um número maior que zero.");
        return;
    }

    // Salva a Venda normalmente
    const dadosVenda = {
        tipo: 'venda',
        loja: lojaSelecionada,
        auditor: usuarioLogado,
        valor: valorNumerico,
        cupomFiscal: cupom,
        qtdItens: vendaItensCount,
        sexo: vendaGeneroSelecionado,
        faixaEtaria: vendaIdadeSelecionada,
        pagamento: pagamento,
        observacao: obs,
        troca: troca,
        virada: virada
    };

    // Se o usuário estiver na aba de vendas, não tenta alterar a aba de fluxo (que está oculta)
    const resultado = await salvarComFila(dadosVenda);
    
    if (resultado.offline) alert("Venda registrada com sucesso (Offline).");
    else alert("Venda gravada com sucesso!");

    limparFormularioVenda();
}

function limparFormularioVenda() {
    document.getElementById('venda-valor').value = "";
    document.getElementById('venda-pagamento').value = "";
    document.getElementById('venda-obs').value = "";
    document.getElementById('venda-cupom').checked = false;
    document.getElementById('venda-troca').checked = false;
    document.getElementById('venda-virada').checked = false;
    
    vendaGeneroSelecionado = null;
    vendaIdadeSelecionada = null;
    vendaItensCount = 1;
    
    document.getElementById('venda-itens').textContent = "1";
    for (let i = 1; i <= 4; i++) document.getElementById('btn-idade-' + i).classList.remove('selecionado');
    document.getElementById('btn-gen-m').classList.remove('selecionado');
    document.getElementById('btn-gen-f').classList.remove('selecionado');
}

// ============================================================
// FLUXO - SALVAMENTO AUTOMÁTICO
// ============================================================
function getDataHoje() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
}

async function alterarFluxo(id, valor) {
    const input = document.getElementById('fluxo-' + id);
    if(!input) return;
    let atual = parseInt(input.textContent) || 0;
    atual += valor;
    if (atual < 0) atual = 0;
    input.textContent = atual;
    await salvarFluxoAuto();
}

async function salvarFluxoAuto() {
    if (!lojaSelecionada || !usuarioLogado) return;

    const statusEl = document.getElementById('fluxo-status');
    if(statusEl) {
        statusEl.textContent = "Salvando...";
        statusEl.className = "fluxo-status salvando";
    }

    const dados = {
        tipo: 'fluxo',
        loja: lojaSelecionada,
        auditor: usuarioLogado,
        data: getDataHoje(),
        especulador_m: parseInt(document.getElementById('fluxo-esp-m').textContent) || 0,
        especulador_f: parseInt(document.getElementById('fluxo-esp-f').textContent) || 0,
        acompanhante_m: parseInt(document.getElementById('fluxo-acomp-m').textContent) || 0,
        acompanhante_f: parseInt(document.getElementById('fluxo-acomp-f').textContent) || 0,
        outros_m: parseInt(document.getElementById('fluxo-out-m').textContent) || 0,
        outros_f: parseInt(document.getElementById('fluxo-out-f').textContent) || 0
    };

    const idDoc = 'fluxo_' + lojaSelecionada.replace(/\s+/g, '-') + '_' + usuarioLogado + '_' + getDataHoje();
    const resultado = await salvarComFila(dados, idDoc);

    if(statusEl) {
        if (resultado.offline) {
            statusEl.textContent = "Salvo localmente (offline) ✓";
            statusEl.className = "fluxo-status salvando";
        } else {
            statusEl.textContent = "Salvo automaticamente ✓";
            statusEl.className = "fluxo-status";
        }

        setTimeout(() => {
            if (estaOnline() && statusEl.textContent === "Salvo automaticamente ✓") {
                statusEl.textContent = "Todos os toques são salvos automaticamente ✓";
                statusEl.className = "fluxo-status";
            }
        }, 1500);
    }
}

async function carregarFluxoHoje() {
    if (!lojaSelecionada || !usuarioLogado) return;

    const idDoc = 'fluxo_' + lojaSelecionada.replace(/\s+/g, '-') + '_' + usuarioLogado + '_' + getDataHoje();

    if (!estaOnline() || !auth.currentUser) {
        const fila = lerFila();
        const itemFluxo = fila.find(i => i._docId === idDoc);
        if (itemFluxo) {
            document.getElementById('fluxo-esp-m').textContent = itemFluxo.especulador_m || 0;
            document.getElementById('fluxo-esp-f').textContent = itemFluxo.especulador_f || 0;
            document.getElementById('fluxo-acomp-m').textContent = itemFluxo.acompanhante_m || 0;
            document.getElementById('fluxo-acomp-f').textContent = itemFluxo.acompanhante_f || 0;
            document.getElementById('fluxo-out-m').textContent = itemFluxo.outros_m || 0;
            document.getElementById('fluxo-out-f').textContent = itemFluxo.outros_f || 0;
        }
        return;
    }

    try {
        const docSnap = await db.collection('registros').doc(idDoc).get();
        if (docSnap.exists) {
            const data = docSnap.data();
            fluxoDocIdHoje = idDoc;
            document.getElementById('fluxo-esp-m').textContent = data.especulador_m || 0;
            document.getElementById('fluxo-esp-f').textContent = data.especulador_f || 0;
            document.getElementById('fluxo-acomp-m').textContent = data.acompanhante_m || 0;
            document.getElementById('fluxo-acomp-f').textContent = data.acompanhante_f || 0;
            document.getElementById('fluxo-out-m').textContent = data.outros_m || 0;
            document.getElementById('fluxo-out-f').textContent = data.outros_f || 0;
        } else {
            const fila = lerFila();
            const itemFluxo = fila.find(i => i._docId === idDoc);
            if (itemFluxo) {
                document.getElementById('fluxo-esp-m').textContent = itemFluxo.especulador_m || 0;
                document.getElementById('fluxo-esp-f').textContent = itemFluxo.especulador_f || 0;
                document.getElementById('fluxo-acomp-m').textContent = itemFluxo.acompanhante_m || 0;
                document.getElementById('fluxo-acomp-f').textContent = itemFluxo.acompanhante_f || 0;
                document.getElementById('fluxo-out-m').textContent = itemFluxo.outros_m || 0;
                document.getElementById('fluxo-out-f').textContent = itemFluxo.outros_f || 0;
            } else {
                fluxoDocIdHoje = null;
                ['esp-m', 'esp-f', 'acomp-m', 'acomp-f', 'out-m', 'out-f'].forEach(id => {
                    const el = document.getElementById('fluxo-' + id);
                    if(el) el.textContent = 0;
                });
            }
        }
    } catch (error) {
        console.error("Erro ao carregar fluxo:", error);
    }
}

// ============================================================
// SALVAR PERDA
// ============================================================
async function salvarPerda() {
    const motivo = document.getElementById('perda-motivo').value;
    const obs = document.getElementById('perda-obs').value;

    if (!motivo) {
        alert("Selecione o motivo da perda.");
        return;
    }

    const dados = {
        tipo: 'perda',
        loja: lojaSelecionada,
        auditor: usuarioLogado,
        motivo: motivo,
        observacao: obs
    };

    const resultado = await salvarComFila(dados);

    if (resultado.offline) alert("Perda registrada com sucesso.");
    else alert("Perda gravada com sucesso!");

    document.getElementById('perda-motivo').value = "";
    document.getElementById('perda-obs').value = "";
}

// ============================================================
// ÚLTIMAS DO DIA
// ============================================================
async function verUltimas(tipo) {
    const modal = document.getElementById('modal-ultimos');
    const lista = document.getElementById('lista-ultimos');
    lista.innerHTML = "<p>Carregando...</p>";
    modal.classList.add('ativa');

    const tipoBanco = tipo === 'vendas' ? 'venda' : (tipo === 'perdas' ? 'perda' : tipo);
    window.tipoAtualModal = tipoBanco;

    const agora = new Date();
    const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 0, 0, 0);
    const fimDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59);

    try {
        let todos = [];

        if (estaOnline() && auth.currentUser) {
            try {
                const snapshot = await db.collection('registros')
                    .where('loja', '==', lojaSelecionada)
                    .where('auditor', '==', usuarioLogado)
                    .get();

                snapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.tipo !== tipoBanco) return;
                    if (data.dataHora) {
                        const ts = data.dataHora.toMillis();
                        if (ts < inicioDia.getTime() || ts > fimDia.getTime()) return;
                    } else {
                        return;
                    }
                    data._id = doc.id;
                    data._origem = 'firebase';
                    todos.push(data);
                });
            } catch (err) { console.warn("Erro ao buscar Firebase:", err); }
        }

        const fila = lerFila();
        fila.forEach(item => {
            if (item.loja !== lojaSelecionada) return;
            if (item.auditor !== usuarioLogado) return;
            if (item.tipo !== tipoBanco) return;

            if (item.dataHoraLocal) {
                const d = new Date(item.dataHoraLocal);
                if (d < inicioDia || d > fimDia) return;
                item._id = item._localId;
                item._origem = 'fila';
                item._timestampMs = d.getTime();
                todos.push(item);
            }
        });

        if (todos.length === 0) {
            lista.innerHTML = "<p>Você ainda não tem registros deste tipo hoje.</p>";
            return;
        }

        todos.sort((a, b) => {
            const ta = a._timestampMs ? a._timestampMs : (a.dataHora ? a.dataHora.toMillis() : 0);
            const tb = b._timestampMs ? b._timestampMs : (b.dataHora ? b.dataHora.toMillis() : 0);
            return tb - ta;
        });

        const dataHojeStr = String(agora.getDate()).padStart(2, '0') + '/' + String(agora.getMonth() + 1).padStart(2, '0') + '/' + agora.getFullYear();

        lista.innerHTML = "";
        const cabecalho = document.createElement('div');
        cabecalho.style.cssText = "background:#1f4e78; color:#fff; padding:8px 12px; border-radius:6px; margin-bottom:12px; font-size:0.85rem; text-align:center;";
        cabecalho.innerHTML = '<strong>' + dataHojeStr + '</strong> — ' + todos.length + ' registro(s) hoje';
        lista.appendChild(cabecalho);

        todos.forEach(data => {
            const item = document.createElement('div');
            item.className = 'item-registro';

            const info = document.createElement('div');
            info.className = 'item-info';

            let horaStr = "—";
            if (data.dataHora) {
                const d = data.dataHora.toDate();
                horaStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
            } else if (data.dataHoraLocal) {
                const d = new Date(data.dataHoraLocal);
                horaStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
            }

            const pendenteIcon = data._origem === 'fila' ? ' <span style="color:#d9534f;">●</span>' : '';

            if (tipoBanco === 'venda') {
                let valorExibicao = "—";
                if (typeof data.valor === 'number' && !isNaN(data.valor)) valorExibicao = data.valor.toFixed(2).replace('.', ',');
                info.innerHTML = '<strong>' + horaStr + '</strong>' + pendenteIcon + ' — R$ ' + valorExibicao + '<br>' + (data.pagamento || '—') + (data.sexo ? ' · ' + data.sexo : '');
            } else if (tipoBanco === 'perda') {
                info.innerHTML = '<strong>' + horaStr + '</strong>' + pendenteIcon + ' — ' + (data.motivo || '—') + (data.observacao ? '<br>' + data.observacao : '');
            } else if (tipoBanco === 'fluxo') {
                info.innerHTML = '<strong>' + horaStr + '</strong>' + pendenteIcon + '<br>Esp: ' + (data.especulador_m || 0) + 'M / ' + (data.especulador_f || 0) + 'F<br>Acomp: ' + (data.acompanhante_m || 0) + 'M / ' + (data.acompanhante_f || 0) + 'F';
            }

            const acoes = document.createElement('div');
            acoes.className = 'item-acoes';

            const btnEditar = document.createElement('button');
            btnEditar.textContent = "✏️";
            btnEditar.className = 'btn-item btn-editar';
            btnEditar.onclick = () => editarRegistro(data._id, tipoBanco);

            const btnExcluir = document.createElement('button');
            btnExcluir.textContent = "🗑️";
            btnExcluir.className = 'btn-item btn-excluir';
            btnExcluir.onclick = () => excluirRegistro(data._id, tipoBanco);

            acoes.appendChild(btnEditar);
            acoes.appendChild(btnExcluir);
            item.appendChild(info);
            item.appendChild(acoes);
            lista.appendChild(item);
        });

        if (tipoBanco === 'venda') {
            let totalDia = 0;
            todos.forEach(v => { totalDia += (parseFloat(v.valor) || 0); });
            const rodape = document.createElement('div');
            rodape.style.cssText = "background:#2f75b5; color:#fff; padding:10px; border-radius:6px; margin-top:12px; text-align:center; font-weight:bold;";
            rodape.innerHTML = 'Total do dia: R$ ' + totalDia.toFixed(2).replace('.', ',');
            lista.appendChild(rodape);
        }

    } catch (error) {
        console.error("Erro ao buscar últimas:", error);
        lista.innerHTML = '<p style="color:#d9534f;">Erro: ' + error.message + '</p>';
    }
}

function fecharModal() {
    document.getElementById('modal-ultimos').classList.remove('ativa');
}

// ============================================================
// EDITAR / EXCLUIR
// ============================================================
async function excluirRegistro(id, tipo) {
    if (!confirm("Tem certeza que deseja EXCLUIR este registro?")) return;

    if (id && id.indexOf('local_') === 0) {
        try {
            removerDaFila(id);
            alert("Registro excluído.");
            atualizarIndicadorFila();
            if(typeof atualizarInfoPainelAdmin === 'function') atualizarInfoPainelAdmin();
            verUltimas(tipo === 'venda' ? 'vendas' : (tipo === 'perda' ? 'perdas' : tipo));
        } catch (err) { alert("Erro ao excluir: " + err.message); }
        return;
    }

    if (!estaOnline() || !auth.currentUser) {
        alert("Sem internet: não é possível excluir itens sincronizados agora.");
        return;
    }

    try {
        await db.collection('registros').doc(id).delete();
        alert("Registro excluído do banco!");
        verUltimas(tipo === 'venda' ? 'vendas' : (tipo === 'perda' ? 'perdas' : tipo));
    } catch (error) { alert("Erro ao excluir: " + error.message); }
}

async function editarRegistro(id, tipo) {
    if (id && id.indexOf('local_') === 0) {
        return await editarRegistroOffline(id, tipo);
    }

    if (!estaOnline() || !auth.currentUser) {
        alert("Sem internet: não é possível editar itens sincronizados agora.");
        return;
    }

    try {
        const docRef = db.collection('registros').doc(id);
        const docSnap = await docRef.get();
        if (!docSnap.exists) return;

        const data = docSnap.data();

        if (tipo === 'venda') {
            const novoValor = prompt("Novo valor (R$):", data.valor);
            if (novoValor === null) return;
            const novasObs = prompt("Nova observação:", data.observacao || "");
            if (novasObs === null) return;
            await docRef.update({ valor: parseFloat(novoValor) || 0, observacao: novasObs });
        } else if (tipo === 'perda') {
            const novaObs = prompt("Nova observação:", data.observacao || "");
            if (novaObs === null) return;
            await docRef.update({ observacao: novaObs });
        } else if (tipo === 'fluxo') {
            const novoEspM = prompt("Especulador Masculino:", data.especulador_m);
            if (novoEspM === null) return;
            const novoEspF = prompt("Especulador Feminino:", data.especulador_f);
            if (novoEspF === null) return;
            await docRef.update({ especulador_m: parseInt(novoEspM) || 0, especulador_f: parseInt(novoEspF) || 0 });
        }

        alert("Registro atualizado!");
        verUltimas(tipo === 'venda' ? 'vendas' : (tipo === 'perda' ? 'perdas' : tipo));
    } catch (error) { alert("Erro ao editar: " + error.message); }
}

async function editarRegistroOffline(localId, tipo) {
    const fila = lerFila();
    const index = fila.findIndex(i => i._localId === localId);
    if (index === -1) { alert("Registro não encontrado."); return; }

    const item = fila[index];

    try {
        if (tipo === 'venda') {
            const novoValor = prompt("Novo valor (R$):", item.valor);
            if (novoValor === null) return;
            item.valor = parseFloat(novoValor) || 0;
        } else if (tipo === 'perda') {
            const novaObs = prompt("Nova observação:", item.observacao || "");
            if (novaObs === null) return;
            item.observacao = novaObs;
        } else if (tipo === 'fluxo') {
            const novoEspM = prompt("Especulador Masculino:", item.especulador_m);
            if (novoEspM === null) return;
            item.especulador_m = parseInt(novoEspM) || 0;
        }

        fila[index] = item;
        salvarFila(fila);

        alert("Registrado com sucesso.");
        atualizarIndicadorFila();
        if(typeof atualizarInfoPainelAdmin === 'function') atualizarInfoPainelAdmin();
        verUltimas(tipo === 'venda' ? 'vendas' : (tipo === 'perda' ? 'perdas' : tipo));
    } catch (error) { alert("Erro ao editar: " + error.message); }
}

// ============================================================
// PAINEL DE SINCRONIZAÇÃO GLOBAL (ADMIN)
// ============================================================
function atualizarPainelAdmin() {
    const painel = document.getElementById('painel-admin-sync');
    const btnSync = document.getElementById('btn-sync-admin');
    if (!painel || !btnSync) return;

    if (ehAdmin()) {
        painel.style.display = 'block';
        btnSync.style.display = 'inline-block';
        atualizarInfoPainelAdmin();
    } else {
        painel.style.display = 'none';
        btnSync.style.display = 'none';
    }
}

function atualizarInfoPainelAdmin() {
    const fila = lerFila();
    const qtdEl = document.getElementById('admin-qtd-fila');
    if (qtdEl) qtdEl.textContent = fila.length;

    const ultimaEl = document.getElementById('admin-ultima-sync');
    if (ultimaEl) {
        const ultima = localStorage.getItem('auditoria_ultima_sync');
        if (ultima) {
            const d = new Date(ultima);
            ultimaEl.textContent = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        } else { ultimaEl.textContent = "Nunca"; }
    }
}

async function sincronizarTudoAdmin() {
    if (!ehAdmin()) return;

    const statusEl = document.getElementById('admin-status-sync');
    const btnSync = document.getElementById('btn-sync-admin');

    if (!estaOnline()) { alert("Sem internet."); return; }

    if (!auth.currentUser) {
        const sessao = lerSessaoOffline();
        if (!sessao) { alert("Sessão expirada."); return; }
        const senha = prompt("Digite sua senha para reautenticar (" + sessao.usuario + "):");
        if (!senha) return;
        try {
            await auth.signInWithEmailAndPassword(sessao.usuario + DOMINIO_FICTICIO, senha);
            usuarioLogado = sessao.usuario;
            await salvarCredencial(sessao.usuario, senha);
        } catch (err) { alert("Falha ao reautenticar."); return; }
    }

    const fila = lerFila();
    if (fila.length === 0) { alert("Não há itens pendentes."); return; }

    if (statusEl) statusEl.textContent = "Sincronizando...";
    if (btnSync) btnSync.disabled = true;

    let sucesso = 0, falhas = 0;

    for (let i = 0; i < fila.length; i++) {
        const item = fila[i];
        try {
            const dados = Object.assign({}, item);
            delete dados._localId; delete dados._dataLocal;
            if (dados.dataHoraLocal) {
                dados.dataHora = firebase.firestore.Timestamp.fromDate(new Date(dados.dataHoraLocal));
                delete dados.dataHoraLocal;
            }
            if (dados._docId) {
                const docId = dados._docId;
                delete dados._docId;
                await db.collection('registros').doc(docId).set(dados, { merge: true });
            } else { await db.collection('registros').add(dados); }
            removerDaFila(item._localId); sucesso++;
            if (statusEl) statusEl.textContent = 'Sincronizando... (' + sucesso + '/' + fila.length + ')';
        } catch (err) { falhas++; }
    }

    localStorage.setItem('auditoria_ultima_sync', new Date().toISOString());
    if (btnSync) btnSync.disabled = false;
    if (statusEl) statusEl.textContent = falhas === 0 ? '✓ ' + sucesso + ' OK!' : '⚠ ' + sucesso + ' OK / ' + falhas + ' falha(s)';

    atualizarInfoPainelAdmin();
    atualizarIndicadorFila();
}

// ============================================================
// EXPORTAÇÃO - GERAR EXCEL AVANÇADO
// ============================================================
async function abrirExportacao(origem) {
    if (!ehAdmin()) { alert("Apenas admin."); return; }

    exportacaoOrigem = origem || 'lojas';
    mostrarTela('tela-exportar');

    const selectLoja = document.getElementById('export-loja');
    selectLoja.innerHTML = '<option value="">Todas as lojas</option>';
    LOJAS.forEach(loja => {
        const opt = document.createElement('option'); opt.value = loja; opt.textContent = loja; selectLoja.appendChild(opt);
    });

    const hoje = new Date();
    const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    document.getElementById('export-data-inicio').value = formatarDataInput(primeiroDia);
    document.getElementById('export-data-fim').value = formatarDataInput(hoje);

    const selectAuditor = document.getElementById('export-auditor');
    selectAuditor.disabled = true;
    selectAuditor.innerHTML = '<option value="">Carregando...</option>';

    try {
        const snapshot = await db.collection('registros').get();
        const setAuditores = {};
        snapshot.forEach(doc => { if (doc.data().auditor) setAuditores[doc.data().auditor] = true; });
        const auditores = Object.keys(setAuditores).sort();
        selectAuditor.innerHTML = '<option value="">Todos os auditores</option>';
        auditores.forEach(a => {
            const opt = document.createElement('option'); opt.value = a; opt.textContent = a; selectAuditor.appendChild(opt);
        });
    } catch (error) { selectAuditor.innerHTML = '<option value="">Erro</option>'; }

    selectAuditor.disabled = false;
    document.getElementById('export-status').textContent = "Selecione o período e clique em Gerar.";
    document.getElementById('export-status').className = "fluxo-status";
}

function formatarDataInput(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fecharExportacao() {
    if (exportacaoOrigem === 'login') {
        auth.signOut().then(() => { usuarioLogado = null; lojaSelecionada = null; mostrarTela('tela-login'); });
    } else { mostrarTela('tela-lojas'); }
}

async function exportarDados() {
    if (!ehAdmin()) return;

    const loja = document.getElementById('export-loja').value;
    let auditor = document.getElementById('export-auditor').value.trim().toLowerCase();
    const dataInicioStr = document.getElementById('export-data-inicio').value;
    const dataFimStr = document.getElementById('export-data-fim').value;
    const incVendas = document.getElementById('export-incluir-vendas').checked;
    const incFluxo = document.getElementById('export-incluir-fluxo').checked;
    const incPerdas = document.getElementById('export-incluir-perdas').checked;

    if (!incVendas && !incFluxo && !incPerdas) { alert("Selecione um tipo de dado."); return; }
    if (!dataInicioStr || !dataFimStr) { alert("Preencha as datas."); return; }

    const statusEl = document.getElementById('export-status');
    statusEl.textContent = "Buscando dados...";
    statusEl.className = "fluxo-status salvando";

    try {
        const dataInicio = new Date(dataInicioStr + 'T00:00:00');
        const dataFim = new Date(dataFimStr + 'T23:59:59');

        let todosRegistros = [];
        const tipos = [];
        if (incVendas) tipos.push('venda');
        if (incFluxo) tipos.push('fluxo');
        if (incPerdas) tipos.push('perda');

        for (let i = 0; i < tipos.length; i++) {
            const tipo = tipos[i];
            const snapshot = await db.collection('registros').where('tipo', '==', tipo).get();
            snapshot.forEach(doc => {
                const data = doc.data();
                data._id = doc.id;
                if (loja && data.loja !== loja) return;
                if (auditor && data.auditor && data.auditor.toLowerCase() !== auditor) return;
                if (data.dataHora) {
                    const ts = data.dataHora.toMillis();
                    if (ts < dataInicio.getTime() || ts > dataFim.getTime()) return;
                }
                todosRegistros.push(data);
            });
        }

        const fila = lerFila();
        fila.forEach(item => {
            if (tipos.indexOf(item.tipo) === -1) return;
            if (loja && item.loja !== loja) return;
            if (auditor && item.auditor && item.auditor.toLowerCase() !== auditor) return;
            if (item.dataHoraLocal) {
                const d = new Date(item.dataHoraLocal);
                if (d < dataInicio || d > dataFim) return;
                const itemFake = Object.assign({}, item);
                itemFake._origem = 'fila';
                itemFake.dataHora = { toDate: function() { return d; }, toMillis: function() { return d.getTime(); } };
                todosRegistros.push(itemFake);
            }
        });

        let todosLogins = [];
        const snapshotLogins = await db.collection('logins').get();
        snapshotLogins.forEach(doc => {
            const data = doc.data();
            if (auditor && data.usuario && data.usuario.toLowerCase() !== auditor) return;
            if (data.dataHora) {
                const ts = data.dataHora.toMillis();
                if (ts < dataInicio.getTime() || ts > dataFim.getTime()) return;
            }
            todosLogins.push(data);
        });

        if (todosRegistros.length === 0 && todosLogins.length === 0) {
            statusEl.textContent = "Nenhum registro encontrado.";
            statusEl.className = "fluxo-status";
            return;
        }

        statusEl.textContent = "Gerando planilha...";
        const xmlExcel = gerarExcelXML(todosRegistros, todosLogins);
        baixarArquivo(xmlExcel, 'auditoria_' + dataInicioStr + '_a_' + dataFimStr + '.xls', 'application/vnd.ms-excel');

        statusEl.textContent = '✓ Relatório gerado com sucesso!';
        statusEl.className = "fluxo-status";

    } catch (error) {
        console.error(error);
        statusEl.textContent = "Erro: " + error.message;
        statusEl.className = "fluxo-status erro";
    }
}

function baixarArquivo(conteudo, nomeArquivo, tipoMime) {
    const blob = new Blob([conteudo], { type: tipoMime + ';charset=utf-8;' });
    if (navigator.msSaveBlob) { navigator.msSaveBlob(blob, nomeArquivo); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = nomeArquivo;
    link.style.display = 'none'; document.body.appendChild(link); link.click();
    setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 100);
}

// ============================================================
// GERADOR DE EXCEL XML (MÚLTIPLAS ABAS E KPIs)
// ============================================================
// ============================================================
// GERADOR DE EXCEL XML (MÚLTIPLAS ABAS, KPIs E BASE PARA GRÁFICOS)
// ============================================================
function gerarExcelXML(registros, logins) {
    const loginsFiltrados = logins.filter(l => l.usuario && l.usuario.toLowerCase() !== USUARIO_ADMIN.toLowerCase());
    const lojasMap = {};
    
    // Inicializa estrutura de dados
    registros.forEach(reg => {
        const l = reg.loja || "Sem Loja";
        if (!lojasMap[l]) {
            lojasMap[l] = { 
                vendas: [], fluxos: [], perdas: [],
                pagamentos: {}, generos: {}, idades: {}, motivosPerda: {}
            };
        }
        
        if (reg.tipo === 'venda') {
            lojasMap[l].vendas.push(reg);
            // Agrega perfil
            const pgto = reg.pagamento || "Não Informado";
            const gen = reg.sexo || "Não Informado";
            const idade = reg.faixaEtaria || "Não Informado";
            const valor = parseFloat(reg.valor) || 0;

            if(!lojasMap[l].pagamentos[pgto]) lojasMap[l].pagamentos[pgto] = {qtd:0, total:0};
            lojasMap[l].pagamentos[pgto].qtd++; lojasMap[l].pagamentos[pgto].total += valor;

            if(!lojasMap[l].generos[gen]) lojasMap[l].generos[gen] = {qtd:0, total:0};
            lojasMap[l].generos[gen].qtd++; lojasMap[l].generos[gen].total += valor;

            if(!lojasMap[l].idades[idade]) lojasMap[l].idades[idade] = {qtd:0, total:0};
            lojasMap[l].idades[idade].qtd++; lojasMap[l].idades[idade].total += valor;
        }
        if (reg.tipo === 'fluxo') lojasMap[l].fluxos.push(reg);
        if (reg.tipo === 'perda') {
            lojasMap[l].perdas.push(reg);
            const motivo = reg.motivo || "Não informado";
            if(!lojasMap[l].motivosPerda[motivo]) lojasMap[l].motivosPerda[motivo] = 0;
            lojasMap[l].motivosPerda[motivo]++;
        }
    });

    let xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Bottom"/>
   <Font ss:FontName="Calibri" x:Family="Swiss" ss:Size="11" ss:Color="#000000"/>
  </Style>
  <Style ss:ID="Header">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#FFFFFF" ss:Bold="1"/>
   <Interior ss:Color="#1F4E78" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="Title">
   <Font ss:FontName="Calibri" ss:Size="18" ss:Color="#1F4E78" ss:Bold="1"/>
  </Style>
  <Style ss:ID="SubTitle">
   <Font ss:FontName="Calibri" ss:Size="14" ss:Color="#2F75B5" ss:Bold="1"/>
  </Style>
  <Style ss:ID="KPI_Label">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#808080"/>
  </Style>
  <Style ss:ID="KPI_Value">
   <Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#1F4E78"/>
   <Interior ss:Color="#E6F0FA" ss:Pattern="Solid"/>
  </Style>
 </Styles>`;

    const getDataStr = (reg) => {
        if (!reg.dataHora) return "";
        const d = reg.dataHora.toDate();
        return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    };
    const getHoraStr = (reg) => {
        if (!reg.dataHora) return "";
        const d = reg.dataHora.toDate();
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };

    // ------------------------------------------------------------
    // CONSOLIDADO GERAL (SOMA DE TODAS AS LOJAS)
    // ------------------------------------------------------------
    let g_vdTotal = 0, g_vdQtd = 0;
    let g_fluxoM = 0, g_fluxoF = 0;
    let g_pagamentos = {}, g_generos = {}, g_idades = {}, g_perdas = {};

    Object.keys(lojasMap).forEach(l => {
        const dados = lojasMap[l];
        
        dados.vendas.forEach(v => { g_vdTotal += (parseFloat(v.valor)||0); g_vdQtd++; });
        
        // O FLUXO TOTAL = Fluxo registrado manualmente + Vendas (caso o usuário tenha esquecido)
        let fluxoM_manual = 0, fluxoF_manual = 0;
        dados.fluxos.forEach(f => { 
            fluxoM_manual += ((f.especulador_m||0)+(f.acompanhante_m||0)+(f.outros_m||0)); 
            fluxoF_manual += ((f.especulador_f||0)+(f.acompanhante_f||0)+(f.outros_f||0)); 
        });

        let vendasM = 0, vendasF = 0;
        dados.vendas.forEach(v => {
            if (v.sexo === 'Masculino') vendasM++;
            if (v.sexo === 'Feminino') vendasF++;
        });

        // Usa o maior valor entre o que foi digitado no fluxo e as vendas reais
        g_fluxoM += Math.max(fluxoM_manual, vendasM);
        g_fluxoF += Math.max(fluxoF_manual, vendasF);

        // Agrega dados globais
        Object.keys(dados.pagamentos).forEach(k => {
            if(!g_pagamentos[k]) g_pagamentos[k] = {qtd:0, total:0};
            g_pagamentos[k].qtd += dados.pagamentos[k].qtd; g_pagamentos[k].total += dados.pagamentos[k].total;
        });
        Object.keys(dados.generos).forEach(k => {
            if(!g_generos[k]) g_generos[k] = {qtd:0, total:0};
            g_generos[k].qtd += dados.generos[k].qtd; g_generos[k].total += dados.generos[k].total;
        });
        Object.keys(dados.idades).forEach(k => {
            if(!g_idades[k]) g_idades[k] = {qtd:0, total:0};
            g_idades[k].qtd += dados.idades[k].qtd; g_idades[k].total += dados.idades[k].total;
        });
        Object.keys(dados.motivosPerda).forEach(k => {
            if(!g_perdas[k]) g_perdas[k] = 0;
            g_perdas[k] += dados.motivosPerda[k];
        });
    });

    const g_ticket = g_vdQtd > 0 ? (g_vdTotal / g_vdQtd) : 0;
    const g_fluxoTotal = g_fluxoM + g_fluxoF;
    const g_conversao = g_fluxoTotal > 0 ? ((g_vdQtd / g_fluxoTotal) * 100) : 0;

    // ------------------------------------------------------------
    // ABA 1: DASHBOARD GERAL (Análise Completa)
    // ------------------------------------------------------------
    xml += `<Worksheet ss:Name="Dashboard Geral">`;
    xml += `<Table>`;
    xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Dashboard Geral do Shopping</Data></Cell></Row>`;
    xml += `<Row></Row>`;
    
    // KPIs Principais
    xml += `<Row>
        <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Total Vendido</Data></Cell>
        <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Qtd. Vendas</Data></Cell>
        <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Ticket Médio</Data></Cell>
        <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Fluxo Total</Data></Cell>
        <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Taxa de Conversão</Data></Cell>
    </Row>`;
    xml += `<Row>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">R$ ${g_vdTotal.toFixed(2).replace('.', ',')}</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="Number">${g_vdQtd}</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">R$ ${g_ticket.toFixed(2).replace('.', ',')}</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">${g_fluxoM} M / ${g_fluxoF} F</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">${g_conversao.toFixed(1)}%</Data></Cell>
    </Row>`;
    xml += `<Row></Row>`;

    // Pagamentos
    xml += `<Row><Cell ss:StyleID="SubTitle"><Data ss:Type="String">Vendas por Forma de Pagamento</Data></Cell></Row>`;
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Pagamento</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Qtd</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Total (R$)</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">%</Data></Cell></Row>`;
    Object.keys(g_pagamentos).sort((a,b) => g_pagamentos[b].total - g_pagamentos[a].total).forEach(k => {
        const p = g_pagamentos[k];
        xml += `<Row>
            <Cell><Data ss:Type="String">${k}</Data></Cell>
            <Cell><Data ss:Type="Number">${p.qtd}</Data></Cell>
            <Cell><Data ss:Type="String">R$ ${p.total.toFixed(2).replace('.', ',')}</Data></Cell>
            <Cell><Data ss:Type="String">${((p.total/(g_vdTotal||1))*100).toFixed(1)}%</Data></Cell>
        </Row>`;
    });
    xml += `<Row></Row>`;

    // Perfil (Gênero)
    xml += `<Row><Cell ss:StyleID="SubTitle"><Data ss:Type="String">Perfil por Gênero</Data></Cell></Row>`;
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Gênero</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Qtd</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Total (R$)</Data></Cell></Row>`;
    Object.keys(g_generos).forEach(k => {
        const gen = g_generos[k];
        xml += `<Row><Cell><Data ss:Type="String">${k}</Data></Cell><Cell><Data ss:Type="Number">${gen.qtd}</Data></Cell><Cell><Data ss:Type="String">R$ ${gen.total.toFixed(2).replace('.', ',')}</Data></Cell></Row>`;
    });
    xml += `<Row></Row>`;

    // Perfil (Idade)
    xml += `<Row><Cell ss:StyleID="SubTitle"><Data ss:Type="String">Perfil por Faixa Etária</Data></Cell></Row>`;
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Idade</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Qtd</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Total (R$)</Data></Cell></Row>`;
    Object.keys(g_idades).forEach(k => {
        const id = g_idades[k];
        xml += `<Row><Cell><Data ss:Type="String">${k}</Data></Cell><Cell><Data ss:Type="Number">${id.qtd}</Data></Cell><Cell><Data ss:Type="String">R$ ${id.total.toFixed(2).replace('.', ',')}</Data></Cell></Row>`;
    });
    xml += `<Row></Row>`;

    // Motivos de Perda
    xml += `<Row><Cell ss:StyleID="SubTitle"><Data ss:Type="String">Motivos de Perda (Shopping)</Data></Cell></Row>`;
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Motivo</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Quantidade</Data></Cell></Row>`;
    Object.keys(g_perdas).forEach(k => {
        xml += `<Row><Cell><Data ss:Type="String">${k}</Data></Cell><Cell><Data ss:Type="Number">${g_perdas[k]}</Data></Cell></Row>`;
    });

    xml += `</Table></Worksheet>`;

    // ------------------------------------------------------------
    // ABAS POR LOJA
    // ------------------------------------------------------------
    Object.keys(lojasMap).sort().forEach(nomeLoja => {
        const dados = lojasMap[nomeLoja];
        
        let totalVendas = 0, qtdVendas = dados.vendas.length;
        
        dados.vendas.forEach(v => { totalVendas += (parseFloat(v.valor)||0); });
        
        // Calcula o fluxo considerando as vendas
        let fluxoM_manual = 0, fluxoF_manual = 0;
        dados.fluxos.forEach(f => { 
            fluxoM_manual += ((f.especulador_m||0)+(f.acompanhante_m||0)+(f.outros_m||0)); 
            fluxoF_manual += ((f.especulador_f||0)+(f.acompanhante_f||0)+(f.outros_f||0)); 
        });
        let vendasM = 0, vendasF = 0;
        dados.vendas.forEach(v => {
            if (v.sexo === 'Masculino') vendasM++;
            if (v.sexo === 'Feminino') vendasF++;
        });
        const fM = Math.max(fluxoM_manual, vendasM);
        const fF = Math.max(fluxoF_manual, vendasF);
        const fluxoTotal = fM + fF;

        const ticketMedio = qtdVendas > 0 ? (totalVendas / qtdVendas) : 0;
        const conversao = fluxoTotal > 0 ? ((qtdVendas / fluxoTotal) * 100) : 0;

        xml += `<Worksheet ss:Name="${nomeLoja.replace(/[\[\]\*\/\\\?:]/g, '')}">`;
        xml += `<Table>`;
        
        xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Relatório: ${nomeLoja}</Data></Cell></Row>`;
        xml += `<Row></Row>`;

        xml += `<Row>
            <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Total Vendido</Data></Cell>
            <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Qtd. Vendas</Data></Cell>
            <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Ticket Médio</Data></Cell>
            <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Fluxo (M/F)</Data></Cell>
            <Cell ss:StyleID="KPI_Label"><Data ss:Type="String">Conversão</Data></Cell>
        </Row>`;
        xml += `<Row>
            <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">R$ ${totalVendas.toFixed(2).replace('.', ',')}</Data></Cell>
            <Cell ss:StyleID="KPI_Value"><Data ss:Type="Number">${qtdVendas}</Data></Cell>
            <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">R$ ${ticketMedio.toFixed(2).replace('.', ',')}</Data></Cell>
            <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">${fM} / ${fF}</Data></Cell>
            <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">${conversao.toFixed(1)}%</Data></Cell>
        </Row>`;
        xml += `<Row></Row>`;

        xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Hora</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Auditor</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Valor</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Itens</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Gênero</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Idade</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Pagamento</Data></Cell></Row>`;
        
        dados.vendas.sort((a,b) => (a.dataHora?.toMillis()||0) - (b.dataHora?.toMillis()||0)).forEach(v => {
            xml += `<Row>
                <Cell><Data ss:Type="String">${getDataStr(v)}</Data></Cell>
                <Cell><Data ss:Type="String">${getHoraStr(v)}</Data></Cell>
                <Cell><Data ss:Type="String">${v.auditor||''}</Data></Cell>
                <Cell><Data ss:Type="String">R$ ${(v.valor||0).toFixed(2).replace('.', ',')}</Data></Cell>
                <Cell><Data ss:Type="Number">${v.qtdItens||1}</Data></Cell>
                <Cell><Data ss:Type="String">${v.sexo||''}</Data></Cell>
                <Cell><Data ss:Type="String">${v.faixaEtaria||''}</Data></Cell>
                <Cell><Data ss:Type="String">${v.pagamento||''}</Data></Cell>
            </Row>`;
        });

        xml += `</Table></Worksheet>`;
    });

    // ------------------------------------------------------------
    // ABA: BASE DE DADOS E LOGINS
    // ------------------------------------------------------------
    xml += `<Worksheet ss:Name="Base para Gráficos">`;
    xml += `<Table>`;
    xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Use esta tabela para criar Tabelas Dinâmicas</Data></Cell></Row>`;
    xml += `<Row></Row>`;
    xml += `<Row>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Loja</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Valor Venda</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Gênero</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Faixa Etária</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Forma Pagamento</Data></Cell>
    </Row>`;
    
    registros.filter(r => r.tipo === 'venda').forEach(v => {
        xml += `<Row>
            <Cell><Data ss:Type="String">${v.loja||''}</Data></Cell>
            <Cell><Data ss:Type="String">${getDataStr(v)}</Data></Cell>
            <Cell><Data ss:Type="Number">${(v.valor||0)}</Data></Cell>
            <Cell><Data ss:Type="String">${v.sexo||''}</Data></Cell>
            <Cell><Data ss:Type="String">${v.faixaEtaria||''}</Data></Cell>
            <Cell><Data ss:Type="String">${v.pagamento||''}</Data></Cell>
        </Row>`;
    });
    xml += `</Table></Worksheet>`;

    xml += `<Worksheet ss:Name="Logins">`;
    xml += `<Table>`;
    xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Logins (Auditores)</Data></Cell></Row>`;
    xml += `<Row></Row>`;
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Hora</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Usuário</Data></Cell></Row>`;
    
    loginsFiltrados.forEach(l => {
        const d = l.dataHora ? l.dataHora.toDate() : new Date();
        xml += `<Row>
            <Cell><Data ss:Type="String">${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}</Data></Cell>
            <Cell><Data ss:Type="String">${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</Data></Cell>
            <Cell><Data ss:Type="String">${l.usuario||''}</Data></Cell>
        </Row>`;
    });

    xml += `</Table></Worksheet>`;
    xml += `</Workbook>`;
    
    return xml;
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
window.onload = () => {
    auth.onAuthStateChanged((user) => {
        if (user) {
            usuarioLogado = user.email.split('@')[0];
            salvarSessaoOffline(usuarioLogado);
            carregarLojas();
            mostrarTela('tela-lojas');
        } else {
            const sessaoOff = lerSessaoOffline();
            if (sessaoOff && sessaoOff.usuario) {
                usuarioLogado = sessaoOff.usuario;
                carregarLojas();
                mostrarTela('tela-lojas');
            } else {
                mostrarTela('tela-login');
            }
        }
        atualizarIndicadorFila();
        atualizarStatusConexao();
        setTimeout(sincronizarFila, 2000);
    });
};

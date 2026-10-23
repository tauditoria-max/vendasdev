// ============================================================
// AUDITORIA SHOPPING - SCRIPT PRINCIPAL MODERNIZADO
// ============================================================

const DOMINIO_FICTICIO = "@tacaruna.com.br";
const USUARIOS_ADMIN = ["diegofilipe", "wesleysantana"];
const LOJAS = ["Aby's", "Hering Kids", "Nel Blu", "Ecológica", "Grandão do Queijo", "Mundo Verde"];

let usuarioLogado = null;
let lojaSelecionada = null;
let fluxoDocIdHoje = null;
let exportacaoOrigem = 'lojas';
let sincronizandoAgora = false;

let vendaGeneroSelecionado = null;
let vendaIdadeSelecionada = null;
let vendaItensCount = 1;

// --- LOGIN OFFLINE ---
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
        } catch (e) {}
    }
    let hash = 0;
    for (let i = 0; i < texto.length; i++) { hash = ((hash << 5) - hash) + texto.charCodeAt(i); hash = hash & hash; }
    return 'fb_' + Math.abs(hash).toString(16);
}

function lerCredenciais() { try { const txt = localStorage.getItem(CRED_KEY); return txt ? JSON.parse(txt) : {}; } catch (e) { return {}; } }
async function salvarCredencial(u, s) { try { const c = lerCredenciais(); c[u.toLowerCase()] = { hash: await hashSenha(s), data: new Date().toISOString() }; localStorage.setItem(CRED_KEY, JSON.stringify(c)); } catch (e) {} }
async function validarCredencialOffline(u, s) { const c = lerCredenciais(); if (!c[u.toLowerCase()]) return false; return c[u.toLowerCase()].hash === await hashSenha(s); }
function salvarSessaoOffline(u) { try { localStorage.setItem(SESSAO_KEY, JSON.stringify({ usuario: u })); } catch (e) {} }
function lerSessaoOffline() { try { const txt = localStorage.getItem(SESSAO_KEY); return txt ? JSON.parse(txt) : null; } catch (e) { return null; } }
function removerSessaoOffline() { try { localStorage.removeItem(SESSAO_KEY); } catch (e) {} }
function estaOnline() { return navigator.onLine !== false; }

// --- FILA OFFLINE ---
const FILA_KEY = 'auditoria_fila_sync';
function lerFila() { try { return JSON.parse(localStorage.getItem(FILA_KEY)) || []; } catch (e) { return []; } }
function salvarFila(f) { localStorage.setItem(FILA_KEY, JSON.stringify(f)); atualizarIndicadorFila(); }

function gerarIdUnico(item) {
    const data = item.dataHoraLocal || new Date().toISOString();
    const hashSeed = item.tipo + (item.loja||'') + data;
    let hash = 0;
    for (let i = 0; i < hashSeed.length; i++) { hash = ((hash << 5) - hash) + hashSeed.charCodeAt(i); hash = hash & hash; }
    return item.tipo + '_' + Math.abs(hash).toString(36) + '_' + Date.now();
}

function adicionarNaFila(item) {
    const fila = lerFila();
    item._localId = 'local_' + Date.now();
    item._dataLocal = new Date().toISOString();
    if (!item._docId) item._docId = gerarIdUnico(item);
    fila.push(item); salvarFila(fila); return item._localId;
}

function removerDaFila(localId) { salvarFila(lerFila().filter(i => i._localId !== localId)); }

function atualizarIndicadorFila() {
    const qtd = lerFila().length;
    const el = document.getElementById('indicador-fila');
    if (!el) return;
    if (qtd === 0) el.style.display = 'none';
    else { el.style.display = 'inline-block'; el.textContent = qtd; }
}

// --- SINCRONIZAÇÃO ---
async function sincronizarFila(silencioso) {
    if (sincronizandoAgora || !estaOnline()) return;
    if (!auth.currentUser && lerSessaoOffline()) {
        if (silencioso) return;
        const sessao = lerSessaoOffline();
        const senha = prompt("Senha para sincronizar (" + sessao.usuario + "):");
        if (!senha) return;
        try { await auth.signInWithEmailAndPassword(sessao.usuario + DOMINIO_FICTICIO, senha); usuarioLogado = sessao.usuario; await salvarCredencial(sessao.usuario, senha); } 
        catch (err) { alert("Falha ao reautenticar."); return; }
    }
    if (!auth.currentUser) return;

    const fila = lerFila();
    if (fila.length === 0) { atualizarStatusConexao(); return; }

    sincronizandoAgora = true;
    for (let i = 0; i < fila.length; i++) {
        const item = fila[i];
        try {
            const dados = Object.assign({}, item);
            const docId = dados._docId;
            delete dados._localId; delete dados._dataLocal; delete dados._docId;
            if (dados.dataHoraLocal) { dados.dataHora = firebase.firestore.Timestamp.fromDate(new Date(dados.dataHoraLocal)); delete dados.dataHoraLocal; }
            else if (!dados.dataHora) { dados.dataHora = firebase.firestore.FieldValue.serverTimestamp(); }
            await db.collection('registros').doc(docId).set(dados, { merge: false });
            removerDaFila(item._localId);
        } catch (err) {}
    }
    sincronizandoAgora = false;
    atualizarStatusConexao();
    if (lojaSelecionada) carregarResumoLoja(lojaSelecionada);
}

async function salvarComFila(dados, docId) {
    const itemParaFila = Object.assign({}, dados);
    itemParaFila.dataHoraLocal = new Date().toISOString();
    if (docId) itemParaFila._docId = docId;

    if (estaOnline() && auth.currentUser) {
        try {
            const dadosEnvio = Object.assign({}, dados);
            dadosEnvio.dataHora = firebase.firestore.FieldValue.serverTimestamp();
            if (docId) await db.collection('registros').doc(docId).set(dadosEnvio, { merge: true });
            else await db.collection('registros').add(dadosEnvio);
            return { offline: false };
        } catch (err) { adicionarNaFila(itemParaFila); return { offline: true }; }
    } else { adicionarNaFila(itemParaFila); return { offline: true }; }
}

window.addEventListener('online', () => { atualizarStatusConexao(); setTimeout(sincronizarFila, 500); });
window.addEventListener('offline', () => atualizarStatusConexao());

function atualizarStatusConexao() {
    const el = document.getElementById('status-conexao');
    const elOff = document.getElementById('sessao-offline-aviso');
    if (el) el.style.display = estaOnline() ? 'none' : 'block';
    if (elOff) elOff.style.display = (!auth.currentUser && lerSessaoOffline() && estaOnline()) ? 'block' : 'none';
}

// --- NAVEGAÇÃO E LOGIN ---
function mostrarTela(idTela) { document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa')); document.getElementById(idTela).classList.add('ativa'); }
function ehAdmin() { 
    return usuarioLogado && USUARIOS_ADMIN.some(u => u.toLowerCase() === usuarioLogado.toLowerCase()); 
}

async function registrarLogin(usuario) {
    if (!estaOnline() || !auth.currentUser) return;
    try { await db.collection('logins').add({ usuario: usuario, dataHora: firebase.firestore.FieldValue.serverTimestamp() }); } catch (error) {}
}

async function fazerLogin() {
    const usuario = document.getElementById('login-usuario').value.trim().toLowerCase();
    const senha = document.getElementById('login-senha').value.trim();
    const erroEl = document.getElementById('login-erro');
    const btn = document.querySelector('#tela-login .btn-primario');

    if (!usuario || !senha) { erroEl.textContent = "Preencha os campos."; return; }
    btn.textContent = "Entrando..."; btn.disabled = true; erroEl.textContent = "";

    if (!estaOnline()) {
        if (await validarCredencialOffline(usuario, senha)) {
            usuarioLogado = usuario; salvarSessaoOffline(usuario); carregarLojas(); mostrarTela('tela-lojas');
            document.getElementById('login-usuario').value = ""; document.getElementById('login-senha').value = "";
            atualizarStatusConexao(); atualizarIndicadorFila(); btn.textContent = "Entrar"; btn.disabled = false; return;
        } else { erroEl.textContent = "Sem internet. Credenciais inválidas."; btn.textContent = "Entrar"; btn.disabled = false; return; }
    }

    try {
        const cred = await auth.signInWithEmailAndPassword(usuario + DOMINIO_FICTICIO, senha);
        usuarioLogado = cred.user.email.split('@')[0];
        await salvarCredencial(usuario, senha); salvarSessaoOffline(usuarioLogado);
        registrarLogin(usuarioLogado); carregarLojas(); mostrarTela('tela-lojas');
        document.getElementById('login-usuario').value = ""; document.getElementById('login-senha').value = "";
        setTimeout(sincronizarFila, 1500);
    } catch (error) {
        if (ehErroDeRede(error) && await validarCredencialOffline(usuario, senha)) {
             usuarioLogado = usuario; salvarSessaoOffline(usuario); carregarLojas(); mostrarTela('tela-lojas');
             document.getElementById('login-usuario').value = ""; document.getElementById('login-senha').value = "";
             atualizarStatusConexao(); atualizarIndicadorFila();
        } else { erroEl.textContent = "Usuário ou senha incorretos."; }
    } finally { btn.textContent = "Entrar"; btn.disabled = false; }
}
function ehErroDeRede(e) { return e.code === 'auth/network-request-failed' || e.code === 'auth/internal-error' || !estaOnline(); }

function fazerLogout() {
    removerSessaoOffline(); if (estaOnline() && auth.currentUser) auth.signOut();
    usuarioLogado = null; lojaSelecionada = null; fluxoDocIdHoje = null; mostrarTela('tela-login');
}

// --- LOJAS E RESUMO ---
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
    
    const btn = document.getElementById('btn-exportar'); 
    if (btn) btn.style.display = ehAdmin() ? 'inline-block' : 'none';
    
    atualizarIndicadorFila(); 
    atualizarStatusConexao(); 
}

function selecionarLoja(loja) {
    lojaSelecionada = loja;
    document.getElementById('nome-loja-header').textContent = loja;
    document.getElementById('nome-auditor-header').textContent = 'Auditor: ' + usuarioLogado;
    mostrarTela('tela-principal'); mudarAba('vendas'); fluxoDocIdHoje = null;
    carregarFluxoHoje(); carregarResumoLoja(loja); atualizarIndicadorFila(); atualizarStatusConexao();
}

function voltarParaLojas() { lojaSelecionada = null; mostrarTela('tela-lojas'); atualizarIndicadorFila(); atualizarStatusConexao(); }

async function carregarResumoLoja(loja) {
    const painel = document.getElementById('resumo-lojas');
    if (!painel) return;
    try {
        const snapshot = await db.collection('registros')
    .where('loja', '==', loja)
    .where('auditor', '==', usuarioLogado)
    .get();
        let vd = 0, p = 0, em = 0, ef = 0, am = 0, af = 0, om = 0, of = 0;
        const hoje = new Date();
        snapshot.forEach(doc => {
            const d = doc.data();
            if (d.dataHora) {
                const dt = d.dataHora.toDate();
                if (dt.getDate() !== hoje.getDate() || dt.getMonth() !== hoje.getMonth() || dt.getFullYear() !== hoje.getFullYear()) return;
            } else return;
            if (d.tipo === 'venda') vd++; if (d.tipo === 'perda') p++;
            if (d.tipo === 'fluxo') { em += d.especulador_m||0; ef += d.especulador_f||0; am += d.acompanhante_m||0; af += d.acompanhante_f||0; om += d.outros_m||0; of += d.outros_f||0; }
        });
        document.getElementById('resumo-vendas').textContent = vd;
        document.getElementById('resumo-perdas').textContent = p;
        document.getElementById('res-esp-m').textContent = em; document.getElementById('res-esp-f').textContent = ef;
        document.getElementById('res-acomp-m').textContent = am; document.getElementById('res-acomp-f').textContent = af;
        document.getElementById('res-out-m').textContent = om; document.getElementById('res-out-f').textContent = of;
        painel.style.display = 'block';
    } catch (error) { painel.style.display = 'none'; }
}

function mudarAba(aba) {
    document.querySelectorAll('.aba').forEach(b => b.classList.remove('ativa')); document.getElementById('aba-' + aba).classList.add('ativa');
    document.querySelectorAll('.conteudo-aba').forEach(c => c.classList.remove('ativa')); document.getElementById('conteudo-' + aba).classList.add('ativa');
}

// --- VENDAS ---
function alterarVendaContador(id, v) { if (id === 'venda-itens') { vendaItensCount += v; if (vendaItensCount < 1) vendaItensCount = 1; document.getElementById('venda-itens').textContent = vendaItensCount; } }
function selecionarGenero(g) { vendaGeneroSelecionado = g; document.getElementById('btn-gen-m').classList.remove('selecionado'); document.getElementById('btn-gen-f').classList.remove('selecionado'); if(g==='Masculino') document.getElementById('btn-gen-m').classList.add('selecionado'); if(g==='Feminino') document.getElementById('btn-gen-f').classList.add('selecionado'); }
function selecionarIdade(i) { vendaIdadeSelecionada = i; for(let x=1;x<=4;x++) document.getElementById('btn-idade-'+x).classList.remove('selecionado'); const map={'Até 19 anos':1,'De 20 a 29 anos':2,'De 30 a 44 anos':3,'45 ou mais':4}; if(map[i]) document.getElementById('btn-idade-'+map[i]).classList.add('selecionado'); }

async function salvarVenda() {
    const getEl = id => document.getElementById(id);
    const valor = getEl('venda-valor').value;
    const pagamento = getEl('venda-pagamento').value;
    if (!valor || !pagamento) return alert("Preencha o Valor e Pagamento.");
    if (!vendaGeneroSelecionado || !vendaIdadeSelecionada) return alert("Selecione Gênero e Idade.");
    const vn = parseFloat(valor); if (isNaN(vn) || vn <= 0) return alert("Valor inválido.");

    const dados = {
        tipo: 'venda', loja: lojaSelecionada, auditor: usuarioLogado, valor: vn,
        cupomFiscal: getEl('venda-cupom') ? getEl('venda-cupom').checked : false,
        qtdItens: vendaItensCount, sexo: vendaGeneroSelecionado, faixaEtaria: vendaIdadeSelecionada,
        pagamento: pagamento, observacao: getEl('venda-obs') ? getEl('venda-obs').value : "",
        troca: getEl('venda-troca') ? getEl('venda-troca').checked : false,
        virada: getEl('venda-virada') ? getEl('venda-virada').checked : false
    };
    const res = await salvarComFila(dados);
    alert(res.offline ? "Salvo offline." : "Venda gravada!");
    limparFormularioVenda();
    if (lojaSelecionada) carregarResumoLoja(lojaSelecionada);
}

function limparFormularioVenda() {
    const limpar = (id, chk=false) => { const el = document.getElementById(id); if (el) { if(chk) el.checked=false; else el.value=""; } };
    limpar('venda-valor'); limpar('venda-pagamento'); limpar('venda-obs');
    limpar('venda-cupom', true); limpar('venda-troca', true); limpar('venda-virada', true);
    vendaGeneroSelecionado = null; vendaIdadeSelecionada = null; vendaItensCount = 1;
    const itens = document.getElementById('venda-itens'); if(itens) itens.textContent = "1";
    for(let i=1;i<=4;i++) { const el = document.getElementById('btn-idade-'+i); if(el) el.classList.remove('selecionado'); }
    const gm = document.getElementById('btn-gen-m'); if(gm) gm.classList.remove('selecionado');
    const gf = document.getElementById('btn-gen-f'); if(gf) gf.classList.remove('selecionado');
}

// --- FLUXO ---
function getDataHoje() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
async function alterarFluxo(id, v) { const el = document.getElementById('fluxo-' + id); if(!el) return; let a = parseInt(el.textContent) || 0; a += v; if(a<0) a=0; el.textContent = a; await salvarFluxoAuto(); }

async function salvarFluxoAuto() {
    if (!lojaSelecionada || !usuarioLogado) return;
    const status = document.getElementById('fluxo-status'); if(status) status.textContent = "Salvando...";
    const dados = {
        tipo: 'fluxo', loja: lojaSelecionada, auditor: usuarioLogado, data: getDataHoje(),
        especulador_m: parseInt(document.getElementById('fluxo-esp-m').textContent)||0, especulador_f: parseInt(document.getElementById('fluxo-esp-f').textContent)||0,
        acompanhante_m: parseInt(document.getElementById('fluxo-acomp-m').textContent)||0, acompanhante_f: parseInt(document.getElementById('fluxo-acomp-f').textContent)||0,
        outros_m: parseInt(document.getElementById('fluxo-out-m').textContent)||0, outros_f: parseInt(document.getElementById('fluxo-out-f').textContent)||0
    };
    const idDoc = 'fluxo_' + lojaSelecionada.replace(/\s+/g,'-') + '_' + usuarioLogado + '_' + getDataHoje();
    await salvarComFila(dados, idDoc);
    if(status) { status.textContent = "Salvo ✓"; setTimeout(() => status.textContent = "Todos os toques são salvos automaticamente ✓", 1500); }
}

async function carregarFluxoHoje() {
    if (!lojaSelecionada || !usuarioLogado) return;
    const idDoc = 'fluxo_' + lojaSelecionada.replace(/\s+/g,'-') + '_' + usuarioLogado + '_' + getDataHoje();
    if (!estaOnline() || !auth.currentUser) {
        const f = lerFila().find(i => i._docId === idDoc);
        if (f) { document.getElementById('fluxo-esp-m').textContent = f.especulador_m||0; document.getElementById('fluxo-esp-f').textContent = f.especulador_f||0; }
        return;
    }
    try {
        const doc = await db.collection('registros').doc(idDoc).get();
        if (doc.exists) {
            const d = doc.data();
            document.getElementById('fluxo-esp-m').textContent = d.especulador_m||0; document.getElementById('fluxo-esp-f').textContent = d.especulador_f||0;
            document.getElementById('fluxo-acomp-m').textContent = d.acompanhante_m||0; document.getElementById('fluxo-acomp-f').textContent = d.acompanhante_f||0;
            document.getElementById('fluxo-out-m').textContent = d.outros_m||0; document.getElementById('fluxo-out-f').textContent = d.outros_f||0;
        }
    } catch(e) {}
}

// --- PERDAS ---
async function salvarPerda() {
    const motivo = document.getElementById('perda-motivo').value;
    if (!motivo) return alert("Selecione o motivo.");
    const dados = { tipo: 'perda', loja: lojaSelecionada, auditor: usuarioLogado, motivo: motivo, observacao: document.getElementById('perda-obs').value };
    const res = await salvarComFila(dados);
    alert(res.offline ? "Salvo offline." : "Perda gravada!");
    document.getElementById('perda-motivo').value = ""; document.getElementById('perda-obs').value = "";
    if (lojaSelecionada) carregarResumoLoja(lojaSelecionada);
}

// --- ULTIMAS E EDIÇÃO ---
async function verUltimas(tipo) {
    const modal = document.getElementById('modal-ultimos'), lista = document.getElementById('lista-ultimos');
    lista.innerHTML = "<p>Carregando...</p>"; modal.classList.add('ativa');
    const t = tipo === 'vendas' ? 'venda' : (tipo === 'perdas' ? 'perda' : tipo);
    const agora = new Date(), ini = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 0,0,0), fim = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23,59,59);
    
    try {
        let todos = [];
        if (estaOnline() && auth.currentUser) {
            const snap = await db.collection('registros').where('loja', '==', lojaSelecionada).where('auditor', '==', usuarioLogado).get();
            snap.forEach(doc => { const d = doc.data(); if(d.tipo===t && d.dataHora && d.dataHora.toMillis()>=ini.getTime() && d.dataHora.toMillis()<=fim.getTime()) { d._id = doc.id; d._origem = 'fb'; todos.push(d); } });
        }
        lerFila().forEach(i => { if(i.loja===lojaSelecionada && i.auditor===usuarioLogado && i.tipo===t && i.dataHoraLocal) { const d = new Date(i.dataHoraLocal); if(d>=ini && d<=fim) { i._id = i._localId; i._origem = 'fila'; i._ts = d.getTime(); todos.push(i); } } });
        
        todos.sort((a,b) => (b._ts||b.dataHora?.toMillis()||0) - (a._ts||a.dataHora?.toMillis()||0));
        if(todos.length===0) { lista.innerHTML = "<p>Nenhum registro hoje.</p>"; return; }
        
        lista.innerHTML = ""; 
        const head = document.createElement('div'); head.style = "background:var(--azul-escuro); padding:8px; border-radius:8px; text-align:center; margin-bottom:10px; font-size:0.8rem; font-weight:bold;"; 
        head.textContent = todos.length + " registro(s) hoje"; lista.appendChild(head);

        todos.forEach(d => {
            const item = document.createElement('div'); item.className = 'item-registro';
            const info = document.createElement('div'); info.className = 'item-info';
            let h = "—"; if(d.dataHora) { const dt = d.dataHora.toDate(); h = String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0'); } else if(d.dataHoraLocal) { const dt = new Date(d.dataHoraLocal); h = String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0'); }
            const pend = d._origem === 'fila' ? ' <span style="color:var(--vermelho)">●</span>' : '';
            
            if(t==='venda') info.innerHTML = `<strong>${h}</strong>${pend} — R$ ${(d.valor||0).toFixed(2).replace('.',',')}<br><span style="font-size:0.75rem">${d.pagamento||''} · Cupom: ${d.cupomFiscal?'Sim':'Não'}</span>`;
            if(t==='perda') info.innerHTML = `<strong>${h}</strong>${pend} — ${d.motivo||''}`;
            if(t==='fluxo') info.innerHTML = `<strong>${h}</strong>${pend}<br><span style="font-size:0.75rem">M: ${d.especulador_m||0} | F: ${d.especulador_f||0}</span>`;

            const acoes = document.createElement('div'); acoes.className = 'item-acoes';
            const btnE = document.createElement('button'); btnE.className = 'btn-item btn-editar'; btnE.innerHTML = "✏️"; btnE.onclick = () => editarRegistro(d._id, t);
            const btnX = document.createElement('button'); btnX.className = 'btn-item btn-excluir'; btnX.innerHTML = "🗑️"; btnX.onclick = () => excluirRegistro(d._id, t);
            acoes.appendChild(btnE); acoes.appendChild(btnX); item.appendChild(info); item.appendChild(acoes); lista.appendChild(item);
        });
    } catch(e) { lista.innerHTML = "<p>Erro ao carregar.</p>"; }
}
function fecharModal() { document.getElementById('modal-ultimos').classList.remove('ativa'); }

async function excluirRegistro(id, t) {
    if(!confirm("Excluir este registro?")) return;
    if(id.includes('local_')) { removerDaFila(id); verUltimas(t); if(lojaSelecionada) carregarResumoLoja(lojaSelecionada); return; }
    try { await db.collection('registros').doc(id).delete(); verUltimas(t); if(lojaSelecionada) carregarResumoLoja(lojaSelecionada); } catch(e) { alert("Erro."); }
}
async function editarRegistro(id, t) {
    if(id.includes('local_')) return alert("Sincronize antes de editar.");
    try {
        const ref = db.collection('registros').doc(id); const snap = await ref.get(); if(!snap.exists) return;
        if(t==='venda') { const v = prompt("Novo valor:", snap.data().valor); if(v) await ref.update({ valor: parseFloat(v) }); }
        if(t==='perda') { const o = prompt("Nova observação:", snap.data().observacao||""); if(o!==null) await ref.update({ observacao: o }); }
        verUltimas(t);
    } catch(e) { alert("Erro."); }
}

// --- EXPORTAÇÃO ---
function abrirExportacao() {
    if(!ehAdmin()) return alert("Apenas admin.");
    mostrarTela('tela-exportar');
    const sl = document.getElementById('export-loja'); sl.innerHTML = '<option value="">Todas</option>'; LOJAS.forEach(l => sl.innerHTML += `<option value="${l}">${l}</option>`);
    const d = new Date(), p = new Date(d.getFullYear(), d.getMonth(), 1);
    document.getElementById('export-data-inicio').value = p.toISOString().split('T')[0]; document.getElementById('export-data-fim').value = d.toISOString().split('T')[0];
}
function fecharExportacao() { mostrarTela('tela-lojas'); }

async function exportarDados() {
    if(!ehAdmin()) return;
    const loja = document.getElementById('export-loja').value, 
          ini = new Date(document.getElementById('export-data-inicio').value+'T00:00:00'), 
          fim = new Date(document.getElementById('export-data-fim').value+'T23:59:59');
    
    const st = document.getElementById('export-status'); 
    st.textContent = "Buscando dados e gerando relatório...";
    
    try {
        const snaps = await db.collection('registros')
    .where('auditor', '==', usuarioLogado)
    .get(); 
        let regs = [];
        snaps.forEach(doc => { 
            const d = doc.data(); 
            if(d.dataHora) { 
                const ts = d.dataHora.toMillis(); 
                if(ts>=ini.getTime() && ts<=fim.getTime()) { 
                    if(loja && d.loja!==loja) return; 
                    regs.push(d); 
                } 
            } 
        });

        // Buscar logins
        let logins = [];
        const snapL = await db.collection('logins').get();
        snapL.forEach(doc => { 
            const d = doc.data(); 
            if(d.dataHora) { 
                const ts = d.dataHora.toMillis(); 
                if(ts>=ini.getTime() && ts<=fim.getTime()) { 
                    logins.push(d); 
                } 
            } 
        });

        const xml = gerarExcel(regs, logins); 
        baixar(xml, `auditoria_${document.getElementById('export-data-inicio').value}.xls`);
        st.textContent = "Relatório gerado com sucesso!";
    } catch(e) { 
        console.error(e);
        st.textContent = "Erro ao gerar relatório."; 
    }
}

function baixar(c, n) { const b = new Blob([c], {type:'application/vnd.ms-excel'}); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href=u; a.download=n; a.click(); }

function gerarExcel(regs, logins) {
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
   <Font ss:FontName="Calibri" ss:Size="16" ss:Color="#1F4E78" ss:Bold="1"/>
  </Style>
  <Style ss:ID="SubTitle">
   <Font ss:FontName="Calibri" ss:Size="12" ss:Color="#2F75B5" ss:Bold="1"/>
  </Style>
  <Style ss:ID="KPI_Label">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#808080"/>
  </Style>
  <Style ss:ID="KPI_Value">
   <Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#1F4E78"/>
   <Interior ss:Color="#E6F0FA" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center"/>
  </Style>
  <Style ss:ID="Money">
   <NumberFormat ss:Format="&quot;R$&quot; #,##0.00"/>
  </Style>
  <Style ss:ID="Bold">
    <Font ss:Bold="1"/>
  </Style>
 </Styles>`;

    // ============================================================
    // PREPARAÇÃO DOS DADOS (Agrupamento por Data e Loja)
    // ============================================================
    const resumoDiario = {}; // Estrutura: resumoDiario[Data][Loja] = { ...dados }
    const g = { vendasQtd: 0, vendasTotal: 0, fluxoTotal: 0, perdasQtd: 0 };

    // Função auxiliar para pegar a data no formato DD/MM/YYYY
    const getDataStr = (d) => {
        if (!d) return "";
        const dt = d.toDate ? d.toDate() : new Date(d);
        return String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + '/' + dt.getFullYear();
    };

    // Inicializa as Lojas em Ordem Alfabética
    const lojasOrdenadas = [...LOJAS].sort();

    regs.forEach(r => {
        const dataStr = getDataStr(r.dataHora);
        if (!dataStr) return; // Ignora registros sem data
        
        const l = r.loja || "Sem Loja";

        if (!resumoDiario[dataStr]) resumoDiario[dataStr] = {};
        if (!resumoDiario[dataStr][l]) {
            resumoDiario[dataStr][l] = {
                vendasQtd: 0, vendasTotal: 0, 
                perdasQtd: 0,
                espM: 0, espF: 0, acompM: 0, acompF: 0, outM: 0, outF: 0
            };
        }

        const bucket = resumoDiario[dataStr][l];

        if (r.tipo === 'venda') {
            const v = parseFloat(r.valor) || 0;
            bucket.vendasQtd++; bucket.vendasTotal += v;
            g.vendasQtd++; g.vendasTotal += v;
        } 
        else if (r.tipo === 'fluxo') {
            bucket.espM += (r.especulador_m||0); bucket.espF += (r.especulador_f||0);
            bucket.acompM += (r.acompanhante_m||0); bucket.acompF += (r.acompanhante_f||0);
            bucket.outM += (r.outros_m||0); bucket.outF += (r.outros_f||0);
            
            g.fluxoTotal += (r.especulador_m||0)+(r.especulador_f||0)+(r.acompanhante_m||0)+(r.acompanhante_f||0)+(r.outros_m||0)+(r.outros_f||0);
        } 
        else if (r.tipo === 'perda') {
            bucket.perdasQtd++; g.perdasQtd++;
        }
    });

    const datasOrdenadas = Object.keys(resumoDiario).sort((a,b) => {
        const [d1,m1,a1] = a.split('/'); const [d2,m2,a2] = b.split('/');
        return new Date(a1,m1-1,d1) - new Date(a2,m2-1,d2);
    });

    // ============================================================
    // ABA 1: DASHBOARD GERAL
    // ============================================================
    xml += `<Worksheet ss:Name="Dashboard Geral"><Table>`;
    xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Dashboard Executivo - Shopping</Data></Cell></Row><Row></Row>`;
    
    xml += `<Row>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Faturamento Total</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Total de Vendas</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Ticket Médio</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Fluxo Total</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Taxa de Conversão</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Total de Perdas</Data></Cell>
    </Row>`;
    xml += `<Row>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="Number">${g.vendasTotal}</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="Number">${g.vendasQtd}</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="Number">${(g.vendasTotal/(g.vendasQtd||1))}</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="Number">${g.fluxoTotal}</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="String">${((g.vendasQtd/(g.fluxoTotal||1))*100).toFixed(1)}%</Data></Cell>
        <Cell ss:StyleID="KPI_Value"><Data ss:Type="Number">${g.perdasQtd}</Data></Cell>
    </Row>`;
    xml += `</Table></Worksheet>`;

    // ============================================================
    // ABA 2: RESUMO FINANCEIRO (DIA x LOJA)
    // ============================================================
    xml += `<Worksheet ss:Name="Faturamento Diário"><Table>`;
    xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Faturamento por Loja e Dia (R$)</Data></Cell></Row><Row></Row>`;
    
    // Cabeçalho
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell>`;
    lojasOrdenadas.forEach(l => { xml += `<Cell ss:StyleID="Header"><Data ss:Type="String">${l}</Data></Cell>`; });
    xml += `<Cell ss:StyleID="Header"><Data ss:Type="String">TOTAL DIA</Data></Cell></Row>`;

    const totaisLojaFat = {}; lojasOrdenadas.forEach(l => totaisLojaFat[l] = 0);
    
    datasOrdenadas.forEach(data => {
        xml += `<Row><Cell><Data ss:Type="String">${data}</Data></Cell>`;
        let totalDia = 0;
        lojasOrdenadas.forEach(l => {
            const val = resumoDiario[data][l] ? resumoDiario[data][l].vendasTotal : 0;
            totalDia += val; totaisLojaFat[l] += val;
            xml += `<Cell ss:StyleID="Money"><Data ss:Type="Number">${val}</Data></Cell>`;
        });
        xml += `<Cell ss:StyleID="Money"><Data ss:Type="Number">${totalDia}</Data></Cell></Row>`;
    });

    // Linha de Total Geral
    xml += `<Row><Cell ss:StyleID="Bold"><Data ss:Type="String">TOTAL GERAL</Data></Cell>`;
    lojasOrdenadas.forEach(l => { xml += `<Cell ss:StyleID="Bold"><Data ss:Type="Number">${totaisLojaFat[l]}</Data></Cell>`; });
    xml += `<Cell ss:StyleID="Bold"><Data ss:Type="Number">${g.vendasTotal}</Data></Cell></Row>`;
    xml += `</Table></Worksheet>`;

    // ============================================================
    // ABA 3: FLUXO DETALHADO (DIA x LOJA)
    // ============================================================
    xml += `<Worksheet ss:Name="Fluxo Detalhado"><Table>`;
    xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Contagem de Fluxo por Loja e Dia</Data></Cell></Row><Row></Row>`;
    
    xml += `<Row>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Loja</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Especulador M</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Especulador F</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Acompanhante M</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Acompanhante F</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Outros M</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Outros F</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">TOTAL LOJA</Data></Cell>
    </Row>`;

    datasOrdenadas.forEach(data => {
        lojasOrdenadas.forEach(l => {
            const b = resumoDiario[data][l];
            if (!b || (b.espM + b.espF + b.acompM + b.acompF + b.outM + b.outF) === 0) return; // Só mostra se teve fluxo
            
            const total = b.espM + b.espF + b.acompM + b.acompF + b.outM + b.outF;
            xml += `<Row>
                <Cell><Data ss:Type="String">${data}</Data></Cell>
                <Cell><Data ss:Type="String">${l}</Data></Cell>
                <Cell><Data ss:Type="Number">${b.espM}</Data></Cell>
                <Cell><Data ss:Type="Number">${b.espF}</Data></Cell>
                <Cell><Data ss:Type="Number">${b.acompM}</Data></Cell>
                <Cell><Data ss:Type="Number">${b.acompF}</Data></Cell>
                <Cell><Data ss:Type="Number">${b.outM}</Data></Cell>
                <Cell><Data ss:Type="Number">${b.outF}</Data></Cell>
                <Cell ss:StyleID="Bold"><Data ss:Type="Number">${total}</Data></Cell>
            </Row>`;
        });
    });
    xml += `</Table></Worksheet>`;

    // ============================================================
    // ABA 4: PERDAS (DIA x LOJA)
    // ============================================================
    xml += `<Worksheet ss:Name="Perdas por Dia"><Table>`;
    xml += `<Row><Cell ss:StyleID="Title"><Data ss:Type="String">Perdas por Loja e Dia</Data></Cell></Row><Row></Row>`;
    
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell>`;
    lojasOrdenadas.forEach(l => { xml += `<Cell ss:StyleID="Header"><Data ss:Type="String">${l}</Data></Cell>`; });
    xml += `<Cell ss:StyleID="Header"><Data ss:Type="String">TOTAL DIA</Data></Cell></Row>`;

    const totaisLojaPerda = {}; lojasOrdenadas.forEach(l => totaisLojaPerda[l] = 0);

    datasOrdenadas.forEach(data => {
        xml += `<Row><Cell><Data ss:Type="String">${data}</Data></Cell>`;
        let totalDia = 0;
        lojasOrdenadas.forEach(l => {
            const qtd = resumoDiario[data][l] ? resumoDiario[data][l].perdasQtd : 0;
            totalDia += qtd; totaisLojaPerda[l] += qtd;
            xml += `<Cell><Data ss:Type="Number">${qtd}</Data></Cell>`;
        });
        xml += `<Cell ss:StyleID="Bold"><Data ss:Type="Number">${totalDia}</Data></Cell></Row>`;
    });
    
    xml += `<Row><Cell ss:StyleID="Bold"><Data ss:Type="String">TOTAL GERAL</Data></Cell>`;
    lojasOrdenadas.forEach(l => { xml += `<Cell ss:StyleID="Bold"><Data ss:Type="Number">${totaisLojaPerda[l]}</Data></Cell>`; });
    xml += `<Cell ss:StyleID="Bold"><Data ss:Type="Number">${g.perdasQtd}</Data></Cell></Row>`;
    xml += `</Table></Worksheet>`;

    // ============================================================
    // ABA 5: BASE DE VENDAS (DETALHADO)
    // ============================================================
    xml += `<Worksheet ss:Name="Base de Vendas"><Table>`;
    xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Loja</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Auditor</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Valor</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Itens</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Cupom</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Gênero</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Idade</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Pagamento</Data></Cell></Row>`;
    
    regs.filter(r => r.tipo === 'venda').forEach(v => {
        xml += `<Row>
            <Cell><Data ss:Type="String">${getDataStr(v.dataHora)}</Data></Cell>
            <Cell><Data ss:Type="String">${v.loja}</Data></Cell>
            <Cell><Data ss:Type="String">${v.auditor}</Data></Cell>
            <Cell ss:StyleID="Money"><Data ss:Type="Number">${v.valor}</Data></Cell>
            <Cell><Data ss:Type="Number">${v.qtdItens||1}</Data></Cell>
            <Cell><Data ss:Type="String">${v.cupomFiscal?'Sim':'Não'}</Data></Cell>
            <Cell><Data ss:Type="String">${v.sexo}</Data></Cell>
            <Cell><Data ss:Type="String">${v.faixaEtaria}</Data></Cell>
            <Cell><Data ss:Type="String">${v.pagamento}</Data></Cell>
        </Row>`;
    });
    xml += `</Table></Worksheet>`;

    // ============================================================
    // ABA 6: LOGINS
    // ============================================================
    if (logins) {
        xml += `<Worksheet ss:Name="Logins"><Table>`;
        xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">Data</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Hora</Data></Cell><Cell ss:StyleID="Header"><Data ss:Type="String">Usuário</Data></Cell></Row>`;
        logins.filter(l => l.usuario && !USUARIOS_ADMIN.some(a => a.toLowerCase() === l.usuario.toLowerCase())).forEach(l => {
            const d = l.dataHora ? l.dataHora.toDate() : new Date();
            xml += `<Row>
                <Cell><Data ss:Type="String">${d.toLocaleDateString('pt-BR')}</Data></Cell>
                <Cell><Data ss:Type="String">${d.toLocaleTimeString('pt-BR').substring(0,5)}</Data></Cell>
                <Cell><Data ss:Type="String">${l.usuario}</Data></Cell>
            </Row>`;
        });
        xml += `</Table></Worksheet>`;
    }

    return xml + `</Workbook>`;
}

window.onload = () => {
    auth.onAuthStateChanged(u => {
        if(u) { usuarioLogado = u.email.split('@')[0]; salvarSessaoOffline(usuarioLogado); carregarLojas(); mostrarTela('tela-lojas'); }
        else { const s = lerSessaoOffline(); if(s) { usuarioLogado = s.usuario; carregarLojas(); mostrarTela('tela-lojas'); } else mostrarTela('tela-login'); }
        atualizarIndicadorFila(); atualizarStatusConexao(); setTimeout(() => sincronizarFila(true), 2000);
    });
};
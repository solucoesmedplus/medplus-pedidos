'use strict';

// A mesma URL atende todos os usuários. Senhas nunca entram nos arquivos públicos.
const API_URL_PADRAO = window.MEDPLUS_CONFIG?.apiUrl?.trim() || '';
const $ = s => document.querySelector(s);
const money = n => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateBR = s => /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : s;
const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});

// Máscara progressiva: até 11 dígitos = CPF; de 12 a 14 = CNPJ.
function formatarDocumento(valor) {
  const numeros = String(valor ?? '').replace(/\D/g, '').slice(0, 14);
  if (numeros.length <= 11) {
    return numeros
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3}\.\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3}\.\d{3}\.\d{3})(\d)/, '$1-$2');
  }
  return numeros.replace(/^(\d{2})(\d{3})(\d{3})(\d{1,4})(\d{0,2})$/,
    (_, a, b, c, d, e) => `${a}.${b}.${c}/${d}${e ? '-' + e : ''}`);
}

function aplicarMascaraDocumento(event) {
  const campo = event.currentTarget;
  const original = campo.value;
  const posicao = campo.selectionStart ?? original.length;
  const digitosAntes = original.slice(0, posicao).replace(/\D/g, '').length;
  campo.value = formatarDocumento(original);
  let cursor = 0;
  let contagem = 0;
  while (cursor < campo.value.length && contagem < digitosAntes) {
    if (/\d/.test(campo.value[cursor])) contagem++;
    cursor++;
  }
  campo.setSelectionRange(cursor, cursor);
}

function stored(key, fallback = '') {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    throw new Error('O navegador não permitiu salvar as configurações. Libere o armazenamento deste site.');
  }
}

let apiUrl = API_URL_PADRAO || stored('medplus.api'),
    key = '',
    mode = 'offline',
    orders = [],
    page = 1,
    editing = null,
    selected = null,
    deleting = null,
    busy = false,
    draftId = '',
    generation = 0;

const PAGE_SIZE = 10;

function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').hidden = true, 5000);
}

function setMode(next) {
  mode = next;
  $('#demoBanner').hidden = next !== 'demo';
  $('#setupBanner').hidden = true;
  $('#connectionLabel').textContent = {
    offline: 'Não conectado',
    demo: 'Demonstração',
    live: 'Planilha conectada'
  }[next];
  $('#connection').className = 'connection ' + ({
    live: 'connected',
    demo: 'demo-mode'
  }[next] || '');
  $('#refresh').disabled = next === 'offline';
}

function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && 
           u.hostname === 'script.google.com' && 
           /^\/macros\/s\/[\w-]+\/exec$/.test(u.pathname) && 
           !u.search && 
           !u.hash;
  } catch {
    return false;
  }
}

async function request(action, data = {}, url = apiUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: auth?.token || '', ...data }),
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal
    });
    
    if (!response.ok) throw new Error('A API respondeu com erro HTTP ' + response.status + '. Confira a implantação.');
    
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('A API não retornou JSON. Publique como aplicativo da Web com acesso “Qualquer pessoa” e use a URL terminada em /exec.');
    }
    
    if (!result.ok) {
      if (result.code === 'AUTH') lockScreen(result.error);
      if (result.code === 'PASSWORD_CHANGE_REQUIRED') { auth.user.trocarSenha = true; requirePasswordChange(); }
      if (result.code === 'ADMIN_REQUIRED') {
        $('#settingsDialog').close();
        $('#adminError').textContent = result.error;
        $('#adminPassword').value = '';
        $('#adminDialog').showModal();
      }
      throw new Error(result.error || 'Não foi possível concluir.');
    }
    return result.data;
    
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('A conexão demorou demais. A operação pode ter sido recebida: atualize a lista antes de tentar novamente.');
    if (err instanceof TypeError) throw new Error('Não foi possível acessar a API. Confira a internet, a URL /exec e as permissões da implantação.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parseFrete(value) {
  const text = String(value).trim();
  if (!text) return 0;
  // Aceita 1234,56, 1.234,56 ou 1234.56; rejeita valores ambíguos/inválidos.
  if (!/^(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2})$/.test(text)) return NaN;
  const valueNumber = Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
  return valueNumber <= 999999999 ? valueNumber : NaN;
}

function total(items, valorFrete = 0) {
  return (items.reduce((s, i) => s + Math.round(i.quantidade * i.valor * 100), 0) + Math.round(valorFrete * 100)) / 100;
}

function filtered() {
  const term = $('#search').value.trim().toLocaleLowerCase('pt-BR'),
        type = $('#typeFilter').value,
        status = $('#statusFilter').value,
        from = $('#fromDate').value,
        to = $('#toDate').value;
        
  return orders.filter(o => 
    (!type || o.tipo === type) &&
    (!status || o.status === status) &&
    (!from || o.data >= from) &&
    (!to || o.data <= to) &&
    (!term || [o.id, o.cliente, o.documento, o.fantasia, o.vendedor, ...o.itens.flatMap(i => [i.descricao, i.modelo, i.serie])].join(' ').toLocaleLowerCase('pt-BR').includes(term))
  ).sort((a, b) => b.data.localeCompare(a.data) || b.criado.localeCompare(a.criado));
}

function render() {
  const list = filtered(),
        pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
        
  page = Math.min(page, pages);
  
  $('#statCount').textContent = list.length;
  $('#statItems').textContent = list.reduce((s, o) => s + o.itens.reduce((n, i) => n + i.quantidade, 0), 0) + ' equipamentos';
  $('#statSales').textContent = money(list.filter(o => o.tipo === 'Venda' && o.status !== 'Cancelado').reduce((s, o) => s + o.total, 0));
  $('#statPurchases').textContent = money(list.filter(o => o.tipo === 'Compra' && o.status !== 'Cancelado').reduce((s, o) => s + o.total, 0));
  $('#statOpen').textContent = list.filter(o => ['Rascunho', 'Confirmado'].includes(o.status)).length;
  
  $('#resultCount').textContent = mode === 'offline' ? 'Conecte sua planilha para começar.' : `${list.length} pedido(s) encontrado(s) • valores sem cancelados`;
  
  $('#ordersBody').innerHTML = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(o => `
    <tr>
      <td>
        <button class="order-link" data-action="view" data-id="${esc(o.id)}">#${esc(o.id.slice(0, 8).toUpperCase())}</button>
        <small>${esc(dateBR(o.data))}</small>
      </td>
      <td class="cell-client">
        <strong>${esc(o.fantasia || o.cliente)}</strong>
        <small>${esc(o.documento)} · ${esc(o.vendedor)}</small>
      </td>
      <td>
        <strong>${esc(o.itens[0]?.descricao || '')}</strong>
        <small>${o.itens.length > 1 ? `+ ${o.itens.length - 1} outro(s) equipamento(s)` : `${o.itens[0]?.quantidade || 0} unidade(s)`}</small>
      </td>
      <td>
        <span class="type-label">${esc(o.tipo)}</span>
        <span class="badge ${esc(o.status)}">${esc(o.status)}</span>
      </td>
      <td>${money(o.total)}</td>
      <td>
        <div class="row-actions">
          <button data-action="view" data-id="${esc(o.id)}" aria-label="Visualizar pedido de ${esc(o.cliente)}" title="Visualizar e imprimir">↗</button>
          <button data-action="edit" data-id="${esc(o.id)}" aria-label="Editar pedido de ${esc(o.cliente)}" title="Editar">✎</button>
          <button class="delete" data-action="delete" data-id="${esc(o.id)}" aria-label="Excluir pedido de ${esc(o.cliente)}" title="Excluir">×</button>
        </div>
      </td>
    </tr>
  `).join('');
  
  $('#empty').hidden = list.length > 0;
  $('#empty p').textContent = mode === 'offline' ? 'Conecte sua planilha ou explore a demonstração.' : orders.length ? 'Experimente outros filtros ou limpe a busca.' : 'Clique em “Novo pedido” para cadastrar o primeiro.';
  
  $('#pageInfo').textContent = `${list.length} pedido(s) · página ${page} de ${pages}`;
  $('#prev').disabled = page <= 1;
  $('#next').disabled = page >= pages;
}

async function refresh() {
  if (mode === 'offline' || busy) return;
  const stamp = generation;
  busy = true;
  $('#refresh').disabled = true;
  $('#listStatus').textContent = 'Atualizando pedidos…';
  
  try {
    const rows = mode === 'demo' ? readDemo() : await request('list');
    if (stamp !== generation) return;
    orders = rows;
    render();
    $('#syncInfo').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR');
    $('#listStatus').textContent = '';
  } catch (e) {
    $('#listStatus').textContent = e.message;
  } finally {
    busy = false;
    $('#refresh').disabled = mode === 'offline';
  }
}

function readDemo() {
  try {
    return JSON.parse(stored('medplus.demo', '[]'));
  } catch {
    return [];
  }
}

function saveDemo(rows) {
  store('medplus.demo', JSON.stringify(rows));
}

function newItem(item = { descricao: '', quantidade: 1, valor: 0, modelo: '', serie: '' }) {
  if ($('#items').children.length >= 100) {
    toast('Limite de 100 equipamentos por pedido.');
    return;
  }
  
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = `
    <label>Equipamento<input data-field="descricao" maxlength="200" required placeholder="Descrição do equipamento" value="${esc(item.descricao)}"></label>
    <label>Qtd.<input data-field="quantidade" type="number" min="1" max="9999" step="1" required value="${item.quantidade}"></label>
    <label>Valor unitário (R$)<input data-field="valor" type="number" min="0" max="999999999" step="0.01" required value="${item.valor}"></label>
    <button type="button" class="remove-item" aria-label="Remover equipamento">×</button>
    <label class="item-model">Marca / modelo<input data-field="modelo" maxlength="160" value="${esc(item.modelo)}" placeholder="Opcional"></label>
    <label class="item-serial">Número de série<input data-field="serie" maxlength="120" value="${esc(item.serie)}" placeholder="Opcional"></label>
    <div class="item-subtotal"></div>
  `;
  $('#items').append(div);
  updateTotal();
}

function collectItems() {
  return [...$('#items').children].map(row => {
    const obj = {};
    row.querySelectorAll('[data-field]').forEach(el => 
      obj[el.dataset.field] = ['quantidade', 'valor'].includes(el.dataset.field) ? Number(el.value) : el.value.trim()
    );
    return obj;
  });
}

function updateTotal() {
  const items = collectItems();
  [...$('#items').children].forEach((r, i) => 
    r.querySelector('.item-subtotal').textContent = 'Subtotal: ' + money(Math.round(items[i].quantidade * items[i].valor * 100) / 100)
  );
  const frete = parseFrete($('#valorFrete').value);
  $('#valorFrete').setCustomValidity(Number.isFinite(frete) ? '' : 'Informe o frete com até duas casas decimais, por exemplo 25,50.');
  $('#formTotal').textContent = Number.isFinite(frete) ? money(total(items, frete)) : 'Frete inválido';
}

function openOrder(o = null) {
  if (mode === 'offline') {
    settings();
    return;
  }
  
  editing = o ? structuredClone(o) : null;
  draftId = o?.id || uid();
  $('#orderForm').reset();
  $('#items').innerHTML = '';
  $('#orderError').textContent = '';
  $('#orderTitle').textContent = o ? 'Editar pedido #' + o.id.slice(0, 8).toUpperCase() : 'Novo pedido';
  
  ['tipo', 'data', 'status', 'vendedor', 'cliente', 'documento', 'fantasia', 'observacoes', 'tipoFrete'].forEach(k => 
    $('#orderForm').elements[k].value = o?.[k] ?? ({ tipo: 'Venda', data: today(), status: 'Rascunho' }[k] || '')
  );
  
  $('#valorFrete').value = Number(o?.valorFrete || 0).toFixed(2).replace('.', ',');

  // Preserva documentos antigos não numéricos, como os exemplos da demonstração.
  const documento = $('#orderForm').elements.documento;
  if (/^[\d.\/\-\s]*$/.test(documento.value) && documento.value.replace(/\D/g, '').length <= 14) {
    documento.value = formatarDocumento(documento.value);
  }

  if (!o && auth) $('#orderForm').elements.vendedor.value = auth.user.nome;
  (o?.itens || [undefined]).forEach(newItem);
  $('#orderDialog').showModal();
}

function closeOrder() {
  if (busy) return;
  if (confirm('Fechar este formulário? Alterações não salvas serão descartadas.')) $('#orderDialog').close();
}

async function submitOrder(e) {
  e.preventDefault();
  if (busy) return;
  
  const f = $('#orderForm');
  const payload = { id: draftId, versao: editing?.versao || 0, itens: collectItems() };
  
  ['tipo', 'data', 'status', 'vendedor', 'cliente', 'documento', 'fantasia', 'observacoes', 'tipoFrete'].forEach(k => 
    payload[k] = f.elements[k].value.trim()
  );
  
  payload.valorFrete = parseFrete(f.elements.valorFrete.value);
  if (!Number.isFinite(payload.valorFrete) || (payload.valorFrete > 0 && !payload.tipoFrete)) {
    $('#orderError').textContent = 'Informe um valor de frete válido e selecione o tipo quando houver cobrança.';
    return;
  }

  if (!payload.itens.length) {
    $('#orderError').textContent = 'Adicione pelo menos um equipamento.';
    return;
  }
  
  busy = true;
  $('#saveOrder').disabled = true;
  $('#orderError').textContent = '';
  
  try {
    let saved;
    if (mode === 'demo') {
      const rows = readDemo();
      saved = {
        ...payload,
        total: total(payload.itens, payload.valorFrete),
        versao: (editing?.versao || 0) + 1,
        criado: editing?.criado || new Date().toISOString()
      };
      const idx = rows.findIndex(o => o.id === payload.id);
      if (idx >= 0) rows[idx] = saved;
      else rows.push(saved);
      saveDemo(rows);
    } else {
      saved = await request('save', { pedido: payload });
    }
    
    orders = orders.filter(o => o.id !== saved.id);
    orders.push(saved);
    render();
    $('#orderDialog').close();
    toast('Pedido salvo' + (mode === 'demo' ? ' na demonstração.' : ' na planilha.'));
  } catch (err) {
    $('#orderError').textContent = err.message;
  } finally {
    busy = false;
    $('#saveOrder').disabled = false;
  }
}

function documentHTML(o) {
  return `
    <article class="document">
      <header class="document-header">
        <img src="assets/logo.png" alt="Med Plus+">
        <div>
          <h2>PEDIDO DE ${esc(o.tipo.toUpperCase())}</h2>
          <strong>#${esc(o.id.slice(0, 8).toUpperCase())}</strong>
          <p>${esc(dateBR(o.data))} · ${esc(o.status)}${mode === 'demo' ? ' · DEMONSTRAÇÃO' : ''}</p>
        </div>
      </header>
      <div class="document-data">
        <div><span>CLIENTE / RAZÃO SOCIAL</span><strong>${esc(o.cliente)}</strong></div>
        <div><span>DOCUMENTO</span><strong>${esc(o.documento)}</strong></div>
        <div><span>NOME FANTASIA</span><strong>${esc(o.fantasia || '—')}</strong></div>
        <div><span>VENDEDOR / RESPONSÁVEL</span><strong>${esc(o.vendedor)}</strong></div>
      </div>
      <table>
        <thead>
          <tr>
            <th style="width:44%">Equipamento</th>
            <th style="width:10%">Qtd.</th>
            <th style="width:23%">Unitário</th>
            <th style="width:23%">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${o.itens.map(i => `
            <tr>
              <td>
                <strong>${esc(i.descricao)}</strong>${i.modelo ? `<small>${esc(i.modelo)}</small>` : ''}
                ${i.serie ? `<small>Série: ${esc(i.serie)}</small>` : ''}
              </td>
              <td>${i.quantidade}</td>
              <td>${money(i.valor)}</td>
              <td>${money(Math.round(i.quantidade * i.valor * 100) / 100)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="document-data">
        <div><span>SUBTOTAL DOS EQUIPAMENTOS</span><strong>${money(total(o.itens))}</strong></div>
        <div><span>TIPO DE FRETE</span><strong>${esc(o.tipoFrete || 'Sem frete / não informado')}</strong></div>
        <div><span>VALOR DO FRETE</span><strong>${money(o.valorFrete || 0)}</strong></div>
      </div>
      <div class="order-total">
        <span>TOTAL DO PEDIDO</span>
        <strong>${money(o.total)}</strong>
      </div>
      ${o.observacoes ? `<h3>Observações e condições</h3><p class="document-notes">${esc(o.observacoes)}</p>` : ''}
      <div class="signatures">
        <span>Med Plus+</span>
        <span>Cliente / fornecedor</span>
      </div>
      <p class="document-footer">MED PLUS+ • Documento de pedido, sem valor fiscal.<br>ID: ${esc(o.id)}</p>
    </article>
  `;
}

function viewOrder(o) {
  selected = o;
  $('#detailContent').innerHTML = documentHTML(o);
  $('#detailDialog').showModal();
}

function askDelete(o) {
  deleting = o;
  $('#deleteText').textContent = `Excluir o pedido #${o.id.slice(0, 8).toUpperCase()} de ${o.cliente}, no valor de ${money(o.total)}?`;
  $('#deleteError').textContent = '';
  $('#confirmDialog').showModal();
}

async function deleteOrder() {
  if (busy || !deleting) return;
  busy = true;
  $('#confirmDelete').disabled = true;
  
  try {
    if (mode === 'demo') {
      saveDemo(readDemo().filter(o => o.id !== deleting.id));
    } else {
      await request('delete', { id: deleting.id, versao: deleting.versao });
    }
    orders = orders.filter(o => o.id !== deleting.id);
    render();
    $('#confirmDialog').close();
    toast('Pedido excluído.');
  } catch (e) {
    $('#deleteError').textContent = e.message;
  } finally {
    busy = false;
    $('#confirmDelete').disabled = false;
  }
}

['#connection', '#navSettings', '#setup', '#leaveDemo'].forEach(s => $(s).onclick = settings);
['#newOrder', '#navNew'].forEach(s => $(s).onclick = () => openOrder());
$('#navOrders').onclick = () => $('#main').scrollIntoView({ behavior: 'smooth' });
$('#refresh').onclick = refresh;
$('#addItem').onclick = () => newItem();
$('#items').addEventListener('input', updateTotal);
$('#valorFrete').addEventListener('input', updateTotal);
$('#valorFrete').addEventListener('blur', () => {
  const value = parseFrete($('#valorFrete').value);
  if (Number.isFinite(value)) $('#valorFrete').value = value.toFixed(2).replace('.', ',');
});
$('#items').addEventListener('click', e => {
  const b = e.target.closest('.remove-item');
  if (!b) return;
  if ($('#items').children.length === 1) {
    toast('Mantenha pelo menos um equipamento.');
    return;
  }
  b.closest('.item').remove();
  updateTotal();
});

const campoDocumento = $('#orderForm').elements.documento;
campoDocumento.inputMode = 'numeric';
campoDocumento.placeholder = '000.000.000-00 ou 00.000.000/0000-00';
// O limite é aplicado aos dígitos na máscara, permitindo colar textos formatados.
campoDocumento.removeAttribute('maxlength');
campoDocumento.addEventListener('input', aplicarMascaraDocumento);

$('#orderForm').addEventListener('submit', submitOrder);
$('#closeOrder').onclick = closeOrder;
$('#cancelOrder').onclick = closeOrder;
$('#orderDialog').addEventListener('cancel', e => {
  e.preventDefault();
  closeOrder();
});

$$close();

function $$close() {
  document.querySelectorAll('[data-close]').forEach(b => {
    b.onclick = () => {
      if (!busy) {
        $('#' + b.dataset.close).close();
      }
    };
  });

  document.querySelectorAll('dialog').forEach(d => {
    d.addEventListener('cancel', e => {
      if (busy) {
        e.preventDefault();
      }
    });
  });
}

$('#ordersBody').addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const o = orders.find(x => x.id === b.dataset.id);
  if (!o) return;
  ({ view: viewOrder, edit: openOrder, delete: askDelete }[b.dataset.action])(o);
});

$('#detailEdit').onclick = () => {
  $('#detailDialog').close();
  openOrder(selected);
};

$('#printOrder').onclick = () => {
  $('#printArea').innerHTML = documentHTML(selected);
  $('#detailDialog').close();
  document.title = 'Pedido-' + selected.id.slice(0, 8) + '-MedPlus';
  window.print();
  document.title = 'Med Plus+ | Pedidos';
};

$('#confirmDelete').onclick = deleteOrder;

['#search', '#typeFilter', '#statusFilter', '#fromDate', '#toDate'].forEach(s => 
  $(s).addEventListener('input', () => {
    page = 1;
    render();
  })
);

$('#clearFilters').onclick = () => {
  ['#search', '#typeFilter', '#statusFilter', '#fromDate', '#toDate'].forEach(s => $(s).value = '');
  page = 1;
  render();
};

$('#prev').onclick = () => {
  page--;
  render();
};

$('#next').onclick = () => {
  page++;
  render();
};

window.addEventListener('beforeunload', e => {
  if (busy || $('#orderDialog').open) {
    e.preventDefault();
    e.returnValue = '';
  }
});

setMode('offline');
render();
// Login individual e retomada automática da sessão nesta aba.
let auth = null;
let adminToken = '';
let authTimer;
let accountRows = [];
let editingUserLogin = '';
function rememberAuth() {
  try { if (auth) sessionStorage.setItem('medplus.session.v2', JSON.stringify({...auth, apiUrl})); else sessionStorage.removeItem('medplus.session.v2'); } catch (_) { /* Sessão continua em memória se o armazenamento estiver bloqueado. */ }
}
function lockScreen(message = '') {
  clearTimeout(authTimer); adminToken = ''; auth = null; rememberAuth();
  orders = []; selected = null; editing = null; deleting = null; generation++;
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  $('#printArea').innerHTML = ''; $('#detailContent').innerHTML = '';
  $('#items').innerHTML = ''; $('#orderForm').reset(); $('#userForm').reset();
  document.body.classList.add('auth-locked'); $('#loginScreen').hidden = false;
  $('#loginPassword').value = ''; $('#adminPassword').value = '';
  $('#loginError').textContent = message;
  setMode('offline'); render();
}
function showApplication() {
  document.body.classList.remove('auth-locked'); $('#loginScreen').hidden = true;
  $('#sessionUser').textContent = auth.user.nome;
  $('#sessionRole').textContent = auth.user.perfil === 'ADMIN' ? 'Administrador' : 'Usuário';
  setMode('live'); render();
  $('#syncInfo').textContent = 'Conectado automaticamente • ' + new Date().toLocaleTimeString('pt-BR');
  clearTimeout(authTimer);
  authTimer = setTimeout(() => lockScreen('Sua sessão expirou. Entre novamente.'), Math.max(0, auth.expires - Date.now()));
}
async function initializeAuth() {
  $('#loginError').textContent = '';
  if (!validUrl(apiUrl)) { $('#loginError').textContent = 'Configuração inicial pendente: o administrador deve preencher a URL /exec em config.js e publicar o arquivo.'; return; }
  try {
    const saved = sessionStorage.getItem('medplus.session.v2');
    if (!saved) return;
    auth = JSON.parse(saved);
    if (auth.apiUrl !== apiUrl || auth.expires <= Date.now()) { lockScreen(); return; }
    $('#loginSubmit').disabled = true;
    const data = await request('me'); auth.user = data.user; auth.expires = data.expires;
    if (auth.user.trocarSenha) { rememberAuth(); requirePasswordChange(); return; }
    orders = await request('list'); rememberAuth(); showApplication();
  } catch (e) { $('#loginError').textContent = e.message; }
  finally { $('#loginSubmit').disabled = false; }
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  if (!validUrl(apiUrl)) { $('#loginError').textContent = 'Peça ao administrador para preencher a URL da API em config.js.'; return; }
  busy = true; $('#loginSubmit').disabled = true; $('#loginError').textContent = '';
  try {
    auth = await request('login', {login:$('#loginUser').value.trim(), senha:$('#loginPassword').value});
    rememberAuth(); $('#loginPassword').value = '';
    if (auth.user.trocarSenha) { requirePasswordChange(); return; }
    orders = await request('list'); page = 1; showApplication();
  } catch (err) { $('#loginError').textContent = err.message; }
  finally { busy = false; $('#loginSubmit').disabled = false; }
});
$('#retryLogin').onclick = initializeAuth;
$('#logout').onclick = async () => {
  if (busy) return;
  busy = true;
  let warning = '';
  try { if (auth) await request('logout'); }
  catch (_) { warning = 'Você saiu deste navegador. Sem conexão, a sessão no servidor expira no prazo de 8 horas.'; }
  finally { busy = false; lockScreen(warning); }
};
function settings() {
  if (busy) return;
  if (!auth) { lockScreen('Entre com seu usuário e senha.'); return; }
  adminToken = ''; $('#adminPassword').value = ''; $('#adminError').textContent = '';
  $('#adminDialog').showModal();
}
$('#adminForm').addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  busy = true; e.submitter.disabled = true; $('#adminError').textContent = '';
  try {
    const grant = await request('adminVerify', {senha:$('#adminPassword').value});
    adminToken = grant.adminToken; $('#adminPassword').value = '';
    accountRows = await request('adminList', {adminToken});
    $('#apiUrl').value = apiUrl; $('#settingsError').textContent = '';
    clearUserForm(); renderAccounts(); $('#adminDialog').close(); $('#settingsDialog').showModal();
  } catch (err) { $('#adminError').textContent = err.message; }
  finally { busy = false; e.submitter.disabled = false; }
});
$('#settingsDialog').addEventListener('close', () => {adminToken = ''; $('#userPassword').value = '';});
function renderAccounts() {
  $('#accountList').innerHTML = accountRows.map(u => `<tr><td><strong>${esc(u.nome)}</strong><small>${esc(u.login)}</small></td><td>${u.perfil === 'ADMIN' ? 'Administrador' : 'Usuário'}<small>${u.ativo ? 'Ativo' : 'Desativado'}</small></td><td><div class="actions"><button type="button" data-account="${esc(u.login)}">Editar</button><button type="button" class="danger" data-delete-account="${esc(u.login)}">Excluir</button></div></td></tr>`).join('');
}
function clearUserForm() {
  editingUserLogin = ''; $('#userForm').reset(); $('#userLogin').readOnly = false; $('#userForcePassword').checked = true;
  $('#userActive').checked = true; $('#userPassword').required = true;
  $('#userFormTitle').textContent = 'Cadastrar usuário';
}
$('#newUser').onclick = clearUserForm;
$('#accountList').addEventListener('click', async e => {
  if (busy) return;
  const remove = e.target.closest('[data-delete-account]');
  if (remove) {
    const login = remove.dataset.deleteAccount;
    if (!confirm('Excluir o usuário ' + login + '? O acesso será removido e as sessões encerradas. Os pedidos serão preservados.')) return;
    busy = true; remove.disabled = true; $('#settingsError').textContent = '';
    try {
      await request('adminDelete', {adminToken, login});
      if (login === auth.user.login) { lockScreen('Seu usuário foi excluído.'); return; }
      accountRows = await request('adminList', {adminToken}); renderAccounts(); clearUserForm(); toast('Usuário excluído.');
    } catch (err) { $('#settingsError').textContent = err.message; }
    finally {busy = false; remove.disabled = false;}
    return;
  }
  const button = e.target.closest('[data-account]'); if (!button) return;
  const u = accountRows.find(x => x.login === button.dataset.account); if (!u) return;
  editingUserLogin = u.login; $('#userLogin').value = u.login; $('#userLogin').readOnly = false; $('#userForcePassword').checked = !!u.trocarSenha;
  $('#userName').value = u.nome; $('#userRole').value = u.perfil; $('#userActive').checked = u.ativo;
  $('#userPassword').value = ''; $('#userPassword').required = false;
  $('#userFormTitle').textContent = 'Editar usuário'; $('#userName').focus();
});
$('#userForm').addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  busy = true; e.submitter.disabled = true; $('#settingsError').textContent = '';
  try {
    const login = $('#userLogin').value.trim().toLowerCase();
    await request('adminSave', {adminToken, usuario:{login,loginOriginal:editingUserLogin,trocarSenha:$('#userForcePassword').checked,nome:$('#userName').value.trim(),perfil:$('#userRole').value,ativo:$('#userActive').checked,senha:$('#userPassword').value}});
    $('#userPassword').value = '';
    if ((editingUserLogin || login) === auth.user.login) { lockScreen('Seu cadastro foi atualizado. Entre novamente.'); return; }
    accountRows = await request('adminList', {adminToken}); renderAccounts(); clearUserForm(); toast('Usuário salvo.');
  } catch (err) { $('#settingsError').textContent = err.message; }
  finally { busy = false; e.submitter.disabled = false; }
});
$('#myPassword').onclick = () => {if(busy)return;$('#passwordNotice').textContent='';$('#passwordLogout').hidden=true;$('#passwordForm').reset();$('#passwordError').textContent='';$('#passwordDialog').showModal();};
$('#passwordForm').addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  if ($('#newPassword').value !== $('#repeatPassword').value) {$('#passwordError').textContent='A confirmação não corresponde à nova senha.';return;}
  busy = true; e.submitter.disabled = true;
  try { await request('changePassword',{senhaAtual:$('#currentPassword').value,novaSenha:$('#newPassword').value});$('#passwordForm').reset();lockScreen('Senha alterada. Entre novamente com a nova senha.'); }
  catch(err){$('#passwordError').textContent=err.message;}
  finally{busy=false;e.submitter.disabled=false;}
});
function requirePasswordChange() {
  orders = []; render(); document.body.classList.add('auth-locked');
  document.querySelectorAll('dialog[open]').forEach(d => {if(d.id !== 'passwordDialog') d.close();});
  $('#passwordForm').reset(); $('#passwordError').textContent = '';
  $('#passwordNotice').textContent = 'Para continuar, substitua sua senha inicial ou redefinida por uma nova senha de pelo menos 8 caracteres.';
  $('#passwordLogout').hidden = false;
  if (!$('#passwordDialog').open) $('#passwordDialog').showModal();
  clearTimeout(authTimer);authTimer = setTimeout(() => lockScreen('Sua sessão expirou. Entre novamente.'), Math.max(0,auth.expires-Date.now()));
}
$('#passwordDialog').addEventListener('cancel', e => {if(auth?.user.trocarSenha)e.preventDefault();});
const passwordClose = document.querySelector('[data-close="passwordDialog"]');
passwordClose.onclick = () => {if(!busy && !auth?.user.trocarSenha)$('#passwordDialog').close();};
$('#passwordLogout').onclick = () => $('#logout').onclick();
initializeAuth();

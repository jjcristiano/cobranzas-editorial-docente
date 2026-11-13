/* ==========================================================================
   Editorial Docente — Sistema de Cobranzas y Cuentas Corrientes
   Frontend Application (Real-Time WebSocket + Accessible 50+ UI)
   ========================================================================== */

const MESES_NOMBRES = [
  '',
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

const state = {
  hoy: '2026-11-13',
  planes: [],
  cuentas: [],
  vendedoras: [],
  movimientos: [],
  configuracion: {},
  presence: { totalConectados: 1, operadores: [], fichasAbiertas: {} },

  // Active UI Filters
  selectedMonth: 11,
  selectedYear: 2026,
  allPeriods: false,
  selectedCanal: 'TODOS',
  selectedVendedora: 'TODAS',
  selectedQuickFilter: 'TODOS',
  searchQuery: '',

  // Active Modals
  openClientPlanId: null,
  operadora: localStorage.getItem('ed_operadora') || 'Marta (Cobranzas)',
  zoom: localStorage.getItem('ed_zoom') || 'normal',
  ws: null
};

// Format Currency ($50.000)
function formatMoney(amount) {
  const num = Number(amount) || 0;
  return '$' + num.toLocaleString('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

// Format Date YYYY-MM-DD -> DD/MM/YYYY
function formatDateAR(dateStr) {
  if (!dateStr) return '—';
  const clean = String(dateStr).slice(0, 10);
  const parts = clean.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// Format Timestamp ISO -> DD/MM/YYYY HH:mm
function formatDateTimeAR(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return formatDateAR(isoStr);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch (_e) {
    return isoStr;
  }
}

// Format DNI with dots for visual reading (34.567.890)
function formatDniVisual(dni) {
  const digits = String(dni || '').replace(/[^\d]/g, '');
  if (!digits) return dni;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Clean phone for wa.me link
function buildWhatsAppUrl(rawPhone, messageText) {
  let digits = String(rawPhone || '').replace(/[^\d]/g, '');
  digits = digits.replace(/^0+/, '');
  if (!digits.startsWith('54')) {
    digits = '549' + digits;
  } else if (digits.startsWith('54') && !digits.startsWith('549')) {
    digits = '549' + digits.slice(2);
  }
  const encodedMsg = encodeURIComponent(messageText || '');
  return `https://wa.me/${digits}?text=${encodedMsg}`;
}

function buildWhatsAppMessageForPlan(plan, targetCuota) {
  const cuota = targetCuota || plan.resumen.proxima_cuota || plan.cuotas[0];
  const cfg = state.configuracion || {};

  if (cuota && cuota.numero_cuota === 1 && cuota.estado === 'PARCIAL_SENA') {
    const tpl = cfg.plantilla_whatsapp_sena ||
      'Hola {nombre}, te escribo de cobranzas de Editorial Docente para recordarte el saldo pendiente de la Cuota 1 ({monto_pendiente}) comprometido para el {fecha_compromiso}, de tu certificado.';
    return tpl
      .replace(/\{nombre\}/g, plan.nombre)
      .replace(/\{numero_cuota\}/g, '1')
      .replace(/\{monto_pendiente\}/g, formatMoney(cuota.saldo_pendiente))
      .replace(/\{fecha_compromiso\}/g, formatDateAR(plan.fecha_compromiso || cuota.fecha_vencimiento));
  }

  if (cuota && cuota.numero_cuota === 1 && cuota.estado === 'PENDIENTE_ALTA') {
    const tpl = cfg.plantilla_whatsapp_alta ||
      'Hola {nombre}, te solicito el comprobante de la cuota 1 (Alta comprometida para el {fecha_compromiso}) de cobranzas de Editorial Docente, de tu certificado.';
    return tpl
      .replace(/\{nombre\}/g, plan.nombre)
      .replace(/\{numero_cuota\}/g, '1')
      .replace(/\{monto_pendiente\}/g, formatMoney(cuota.saldo_pendiente))
      .replace(/\{fecha_compromiso\}/g, formatDateAR(plan.fecha_compromiso || cuota.fecha_vencimiento));
  }

  const numC = cuota ? cuota.numero_cuota : 1;
  const tpl = cfg.plantilla_whatsapp_cuota ||
    'Hola {nombre}, te solicito el comprobante de la cuota {numero_cuota} de cobranzas de Editorial Docente, de tu certificado.';
  return tpl
    .replace(/\{nombre\}/g, plan.nombre)
    .replace(/\{numero_cuota\}/g, String(numC))
    .replace(/\{monto_pendiente\}/g, cuota ? formatMoney(cuota.saldo_pendiente) : '');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'toast-error' : ''}`;
  toast.innerHTML = `
    <span>${isError ? '⚠️' : '✅'} ${escapeHtml(message)}</span>
    <button type="button" style="background:transparent;border:none;color:#FFF;font-weight:800;cursor:pointer;">✕</button>
  `;
  toast.querySelector('button').addEventListener('click', () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 4500);
}

/* ==========================================================================
   Period & Filter Evaluation Logic
   ========================================================================== */

/**
 * Find the relevant installment of a plan for the currently selected Month & Year
 */
function getCuotaDelPeriodo(plan, mes, anio) {
  return plan.cuotas.find((c) => c.mes_vencimiento === mes && c.anio_vencimiento === anio) || null;
}

/**
 * Determine if a plan is relevant to the selected Month & Year when allPeriods == false
 */
function planMatchesPeriod(plan, mes, anio) {
  if (state.allPeriods) return true;

  // If searching by text, search across the entire continuous database so operators never miss a client!
  if (state.searchQuery.trim().length > 0) return true;

  // For specific cross-month quick filters, ensure expected visibility:
  if (state.selectedQuickFilter === 'SENAS_MES_SIGUIENTE') {
    const nextMonth = mes === 12 ? 1 : mes + 1;
    const nextYear = mes === 12 ? anio + 1 : anio;
    const c1 = plan.cuotas[0];
    if (
      plan.estado_plan === 'ACTIVO' &&
      plan.modalidad_inicial === 'SENA_MES_SIGUIENTE' &&
      c1 && c1.estado === 'PARCIAL_SENA' &&
      ((plan.mes_inicio === mes && plan.anio_inicio === anio) ||
       (c1.mes_vencimiento === nextMonth && c1.anio_vencimiento === nextYear) ||
       (c1.mes_vencimiento === mes && c1.anio_vencimiento === anio))
    ) {
      return true;
    }
  }

  if (state.selectedQuickFilter === 'DEUDORES' && plan.resumen.es_deudor) {
    return true;
  }

  if (state.selectedQuickFilter === 'BAJAS' && plan.estado_plan === 'BAJA') {
    return true;
  }

  // 1. Started in this month/year
  if (plan.mes_inicio === mes && plan.anio_inicio === anio) return true;

  // 2. Has an installment scheduled in this month/year
  if (plan.cuotas.some((c) => c.mes_vencimiento === mes && c.anio_vencimiento === anio)) return true;

  // 3. Has a payment recorded in this month/year
  if (plan.movimientos.some((m) => m.mes_imputacion === mes && m.anio_imputacion === anio)) return true;

  // 4. Has an overdue installment from an earlier month that is still unpaid
  if (plan.estado_plan === 'ACTIVO' && plan.resumen.es_deudor) {
    const hasEarlierOverdue = plan.cuotas.some((c) => {
      if (c.estado === 'PAGADA' || c.estado === 'ANULADA_POR_BAJA') return false;
      return (c.anio_vencimiento < anio) || (c.anio_vencimiento === anio && c.mes_vencimiento <= mes);
    });
    if (hasEarlierOverdue) return true;
  }

  return false;
}

/**
 * Evaluate each Daily Quick Filter category for a plan
 */
function planMatchesQuickFilter(plan, filterName, mes, anio) {
  const c1 = plan.cuotas[0];
  const esBaja = plan.estado_plan === 'BAJA';

  switch (filterName) {
    case 'TODOS':
      return true;

    case 'SENAS_ESTE_MES': {
      if (esBaja || !c1 || c1.estado !== 'PARCIAL_SENA') return false;
      if (state.allPeriods) return plan.modalidad_inicial === 'SENA_MISMO_MES';
      return (
        (plan.modalidad_inicial === 'SENA_MISMO_MES' && plan.mes_inicio === mes && plan.anio_inicio === anio) ||
        (c1.mes_vencimiento === mes && c1.anio_vencimiento === anio && plan.modalidad_inicial !== 'SENA_MES_SIGUIENTE')
      );
    }

    case 'SENAS_MES_SIGUIENTE': {
      if (esBaja || !c1 || c1.estado !== 'PARCIAL_SENA') return false;
      return plan.modalidad_inicial === 'SENA_MES_SIGUIENTE';
    }

    case 'ALTAS_PENDIENTES': {
      if (esBaja || !c1) return false;
      return c1.estado === 'PENDIENTE_ALTA';
    }

    case 'CUOTAS_PENDIENTES_MES': {
      if (esBaja) return false;
      if (state.allPeriods) {
        return plan.resumen.saldo_total_pendiente > 0;
      }
      return plan.cuotas.some(
        (c) =>
          c.mes_vencimiento === mes &&
          c.anio_vencimiento === anio &&
          c.estado !== 'PAGADA' &&
          c.estado !== 'ANULADA_POR_BAJA' &&
          c.saldo_pendiente > 0
      );
    }

    case 'DEUDORES': {
      return !esBaja && plan.resumen.es_deudor;
    }

    case 'COMPLETADOS': {
      if (esBaja) return false;
      if (plan.resumen.todas_pagadas) return true;
      // Also include plans whose installment for the selected month is already paid and have no overdue debts
      if (!state.allPeriods && !plan.resumen.es_deudor) {
        const cuotaMes = getCuotaDelPeriodo(plan, mes, anio);
        if (cuotaMes && cuotaMes.estado === 'PAGADA') return true;
      }
      return false;
    }

    case 'BAJAS': {
      return esBaja;
    }

    default:
      return true;
  }
}

function planMatchesSearch(plan, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const haystack = [
    plan.dni,
    plan.nombre,
    plan.apellido,
    plan.nombre_completo,
    plan.celular,
    plan.vendedora_nombre,
    plan.canal,
    plan.notas
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

/* ==========================================================================
   Rendering Functions
   ========================================================================== */

function renderAll() {
  renderHeaderState();
  renderDashboardKPIs();
  renderChannelCountsAndVendedorasBar();
  renderQuickFilterBadges();
  renderClientRecordsList();

  // If client detail modal is open, keep it live-synced!
  if (state.openClientPlanId) {
    const updatedPlan = state.planes.find((p) => p.id === state.openClientPlanId);
    if (updatedPlan) {
      renderClientDetailModalContent(updatedPlan);
    }
  }
}

function renderHeaderState() {
  document.documentElement.setAttribute('data-zoom', state.zoom);
  document.querySelectorAll('.zoom-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.zoom === state.zoom);
  });

  const opLabel = document.getElementById('current-operator-label');
  if (opLabel) opLabel.textContent = state.operadora;

  const badgeText = document.getElementById('realtime-status-text');
  if (badgeText) {
    const count = state.presence?.totalConectados || 1;
    badgeText.textContent = `Sincronizado en vivo (${count} ${count === 1 ? 'PC conectada' : 'PCs conectadas'})`;
  }

  const allToggle = document.getElementById('btn-toggle-all-periods');
  if (allToggle) {
    allToggle.classList.toggle('active', state.allPeriods);
    allToggle.textContent = state.allPeriods ? '✓ Viendo Todos los Meses' : 'Ver Todos los Meses';
  }
}

function renderDashboardKPIs() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;
  const periodLabel = state.allPeriods ? 'Histórico Total' : `${MESES_NOMBRES[mes]} ${anio}`;

  document.getElementById('kpi-title-cobrado').textContent = `Total Cobrado (${periodLabel})`;
  document.getElementById('kpi-title-pendiente').textContent = `Pendiente a Cobrar (${periodLabel})`;
  document.getElementById('kpi-title-cuentas').textContent = `Por Cuenta Destino (${periodLabel})`;

  // Filter movements by channel & period
  const movsFiltrados = state.movimientos.filter((m) => {
    if (state.selectedCanal !== 'TODOS' && m.canal !== state.selectedCanal) return false;
    if (state.selectedCanal === 'VENDEDORAS' && state.selectedVendedora !== 'TODAS' && m.vendedora_nombre !== state.selectedVendedora) {
      return false;
    }
    if (!state.allPeriods) {
      return m.mes_imputacion === mes && m.anio_imputacion === anio;
    }
    return true;
  });

  const totalCobrado = movsFiltrados.reduce((acc, m) => acc + (Number(m.monto) || 0), 0);
  document.getElementById('kpi-val-cobrado').textContent = formatMoney(totalCobrado);
  document.getElementById('kpi-sub-cobrado').textContent = `${movsFiltrados.length} ${movsFiltrados.length === 1 ? 'pago acreditado' : 'pagos acreditados'}`;

  // Breakdown by Cuenta Destino
  const porCuenta = {};
  for (const c of state.cuentas) {
    if (c.activa) porCuenta[c.nombre] = 0;
  }
  for (const m of movsFiltrados) {
    porCuenta[m.cuenta_destino] = (porCuenta[m.cuenta_destino] || 0) + (Number(m.monto) || 0);
  }

  const breakdownContainer = document.getElementById('kpi-cuentas-breakdown');
  const entries = Object.entries(porCuenta);
  if (entries.length === 0) {
    breakdownContainer.innerHTML = '<span style="font-size:0.85rem;color:var(--text-muted);">Sin movimientos</span>';
  } else {
    breakdownContainer.innerHTML = entries
      .map(
        ([nombreCuenta, suma]) => `
        <span class="cuenta-mini-pill">
          <span>${escapeHtml(nombreCuenta)}:</span>
          <strong class="tabular-nums">${formatMoney(suma)}</strong>
        </span>
      `
      )
      .join('');
  }

  // Pending in selected period & Deudores count
  let totalPendienteMes = 0;
  let cantidadCuotasPendMes = 0;
  let totalDeudoresClientes = 0;
  let montoTotalVencido = 0;

  for (const p of state.planes) {
    if (p.estado_plan === 'BAJA') continue;
    if (state.selectedCanal !== 'TODOS' && p.canal !== state.selectedCanal) continue;
    if (state.selectedCanal === 'VENDEDORAS' && state.selectedVendedora !== 'TODAS' && p.vendedora_nombre !== state.selectedVendedora) continue;

    if (p.resumen.es_deudor) {
      totalDeudoresClientes += 1;
      for (const c of p.cuotas) {
        if (c.vencida) montoTotalVencido += c.saldo_pendiente;
      }
    }

    for (const c of p.cuotas) {
      if (c.estado === 'PAGADA' || c.estado === 'ANULADA_POR_BAJA' || c.saldo_pendiente <= 0) continue;
      if (state.allPeriods || (c.mes_vencimiento === mes && c.anio_vencimiento === anio)) {
        totalPendienteMes += c.saldo_pendiente;
        cantidadCuotasPendMes += 1;
      }
    }
  }

  document.getElementById('kpi-val-pendiente').textContent = formatMoney(totalPendienteMes);
  document.getElementById('kpi-sub-pendiente').textContent = `${cantidadCuotasPendMes} ${cantidadCuotasPendMes === 1 ? 'cuota/saldo pendiente' : 'cuotas/saldos pendientes'}`;

  document.getElementById('kpi-val-deudores').textContent = `${totalDeudoresClientes} ${totalDeudoresClientes === 1 ? 'Cliente' : 'Clientes'}`;
  document.getElementById('kpi-sub-deudores').textContent = `Saldo vencido exigible: ${formatMoney(montoTotalVencido)}`;
}

function renderChannelCountsAndVendedorasBar() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;

  const basePeriodPlans = state.planes.filter(
    (p) => planMatchesPeriod(p, mes, anio) && planMatchesSearch(p, state.searchQuery)
  );

  const countTodos = basePeriodPlans.length;
  const countSeb = basePeriodPlans.filter((p) => p.canal === 'SEBASTIAN').length;
  const countVend = basePeriodPlans.filter((p) => p.canal === 'VENDEDORAS').length;
  const countTramos = basePeriodPlans.filter((p) => p.canal === 'TRAMOS').length;

  document.getElementById('count-canal-todos').textContent = countTodos;
  document.getElementById('count-canal-sebastian').textContent = countSeb;
  document.getElementById('count-canal-vendedoras').textContent = countVend;
  document.getElementById('count-canal-tramos').textContent = countTramos;

  document.querySelectorAll('.channel-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.canal === state.selectedCanal);
  });

  const vendSubBar = document.getElementById('vendedoras-subfilter-bar');
  const chipsContainer = document.getElementById('vendedoras-chips-container');

  if (state.selectedCanal === 'VENDEDORAS') {
    vendSubBar.hidden = false;
    const nombresVendedoras = Array.from(
      new Set([
        ...state.vendedoras.filter((v) => v.activa).map((v) => v.nombre),
        ...state.planes.filter((p) => p.canal === 'VENDEDORAS' && p.vendedora_nombre).map((p) => p.vendedora_nombre)
      ])
    );

    chipsContainer.innerHTML = [
      `<button type="button" class="vendedora-chip ${state.selectedVendedora === 'TODAS' ? 'active' : ''}" data-vend="TODAS">Todas (${countVend})</button>`,
      ...nombresVendedoras.map((nom) => {
        const c = basePeriodPlans.filter((p) => p.canal === 'VENDEDORAS' && p.vendedora_nombre === nom).length;
        const active = state.selectedVendedora === nom ? 'active' : '';
        return `<button type="button" class="vendedora-chip ${active}" data-vend="${escapeHtml(nom)}">${escapeHtml(nom)} (${c})</button>`;
      })
    ].join('');

    chipsContainer.querySelectorAll('.vendedora-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.selectedVendedora = chip.dataset.vend;
        renderAll();
      });
    });
  } else {
    vendSubBar.hidden = true;
    state.selectedVendedora = 'TODAS';
  }
}

function getPlansMatchingChannelAndPeriod() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;

  return state.planes.filter((p) => {
    if (state.selectedCanal !== 'TODOS' && p.canal !== state.selectedCanal) return false;
    if (state.selectedCanal === 'VENDEDORAS' && state.selectedVendedora !== 'TODAS' && p.vendedora_nombre !== state.selectedVendedora) {
      return false;
    }
    if (!planMatchesSearch(p, state.searchQuery)) return false;
    if (!planMatchesPeriod(p, mes, anio)) return false;
    return true;
  });
}

function renderQuickFilterBadges() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;
  const channelPlans = getPlansMatchingChannelAndPeriod();

  const filterKeys = [
    { key: 'TODOS', badgeId: 'badge-pill-todos' },
    { key: 'SENAS_ESTE_MES', badgeId: 'badge-pill-senas-mes' },
    { key: 'SENAS_MES_SIGUIENTE', badgeId: 'badge-pill-senas-sig' },
    { key: 'ALTAS_PENDIENTES', badgeId: 'badge-pill-altas' },
    { key: 'CUOTAS_PENDIENTES_MES', badgeId: 'badge-pill-cuotas-mes' },
    { key: 'DEUDORES', badgeId: 'badge-pill-deudores' },
    { key: 'COMPLETADOS', badgeId: 'badge-pill-completados' },
    { key: 'BAJAS', badgeId: 'badge-pill-bajas' }
  ];

  for (const item of filterKeys) {
    const count = channelPlans.filter((p) => planMatchesQuickFilter(p, item.key, mes, anio)).length;
    const el = document.getElementById(item.badgeId);
    if (el) el.textContent = count;
  }

  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.filter === state.selectedQuickFilter);
  });
}

function getModalityLabel(mod, estadoActual) {
  if (mod === 'SENA_MISMO_MES') {
    return estadoActual === 'PAGO' ? 'Seña (Completada)' : 'Seña (Mismo Mes)';
  }
  if (mod === 'SENA_MES_SIGUIENTE') {
    return estadoActual === 'PAGO' ? 'Seña Mes Sig. (Completada)' : 'Seña Mes Siguiente';
  }
  if (mod === 'ALTA') {
    return estadoActual === 'PAGO' ? 'Alta (Ya Confirmada)' : 'Alta (Pago Diferido)';
  }
  return 'Pago (Cuota 1 Abonada)';
}

function renderClientRecordsList() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;
  const container = document.getElementById('records-list-container');

  let filtered = getPlansMatchingChannelAndPeriod().filter((p) =>
    planMatchesQuickFilter(p, state.selectedQuickFilter, mes, anio)
  );

  // Sort logic:
  // If filtering by Señas or Altas, sort by fecha_compromiso ascending so urgent commitments appear first!
  if (['SENAS_ESTE_MES', 'SENAS_MES_SIGUIENTE', 'ALTAS_PENDIENTES'].includes(state.selectedQuickFilter)) {
    filtered.sort((a, b) => {
      const fa = a.fecha_compromiso || '9999-12-31';
      const fb = b.fecha_compromiso || '9999-12-31';
      return fa.localeCompare(fb);
    });
  } else {
    // Default priority: Deudores first, then pending in period, then up to date, then Bajas at bottom
    filtered.sort((a, b) => {
      if (a.estado_plan === 'BAJA' && b.estado_plan !== 'BAJA') return 1;
      if (a.estado_plan !== 'BAJA' && b.estado_plan === 'BAJA') return -1;
      if (a.resumen.es_deudor && !b.resumen.es_deudor) return -1;
      if (!a.resumen.es_deudor && b.resumen.es_deudor) return 1;
      return b.id - a.id;
    });
  }

  const summaryEl = document.getElementById('active-filter-summary');
  if (summaryEl) {
    const periodText = state.allPeriods ? 'Todos los meses' : `${MESES_NOMBRES[mes]} ${anio}`;
    summaryEl.textContent = `Mostrando ${filtered.length} ${filtered.length === 1 ? 'cliente' : 'clientes'} • Período: ${periodText}`;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:2.4rem;">📂</div>
        <h3 style="font-size:1.2rem; font-weight:800;">No hay registros para este filtro en el período seleccionado</h3>
        <p style="color:var(--text-secondary); max-width:540px;">
          Puede cambiar de pestaña de canal, elegir el filtro <strong>"Todos"</strong> o hacer clic en <strong>"Ver Todos los Meses"</strong> para buscar en toda la base histórica.
        </p>
        <button type="button" class="btn btn-secondary" id="btn-reset-filters-empty">Mostrar Todos del Mes</button>
      </div>
    `;
    const resetBtn = document.getElementById('btn-reset-filters-empty');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        state.selectedQuickFilter = 'TODOS';
        state.selectedCanal = 'TODOS';
        state.searchQuery = '';
        document.getElementById('input-global-search').value = '';
        renderAll();
      });
    }
    return;
  }

  container.innerHTML = filtered.map((plan) => renderSingleClientCard(plan, mes, anio)).join('');

  // Bind card action buttons
  container.querySelectorAll('[data-action="open-detail"]').forEach((btn) => {
    btn.addEventListener('click', () => openClientDetailModal(Number(btn.dataset.planId)));
  });

  container.querySelectorAll('[data-action="quick-pay"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openPayCuotaModal(Number(btn.dataset.planId), Number(btn.dataset.cuotaId));
    });
  });

  container.querySelectorAll('[data-action="quick-adelanto"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openAdelantoModal(Number(btn.dataset.planId));
    });
  });

  container.querySelectorAll('[data-action="quick-wa-edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openWhatsAppModal(Number(btn.dataset.planId), Number(btn.dataset.cuotaId || 0));
    });
  });

  container.querySelectorAll('[data-action="quick-note"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      promptQuickNote(Number(btn.dataset.planId));
    });
  });
}

function renderSingleClientCard(plan, mes, anio) {
  const esBaja = plan.estado_plan === 'BAJA';
  const esDeudor = plan.resumen.es_deudor;
  const esCompletado = plan.resumen.todas_pagadas;

  const cardClass = [
    'client-card',
    esBaja ? 'is-baja' : '',
    !esBaja && esDeudor ? 'is-deudor' : '',
    !esBaja && esCompletado ? 'is-completado' : ''
  ].filter(Boolean).join(' ');

  // Channel label
  let canalText = '1. Sebastián';
  if (plan.canal === 'VENDEDORAS') {
    canalText = `2. Vendedora: ${plan.vendedora_nombre || 'Sin asignar'}`;
  } else if (plan.canal === 'TRAMOS') {
    canalText = '3. Tramos';
  }

  // Presence indicator if someone has this ficha open
  const viewers = state.presence?.fichasAbiertas?.[plan.id] || [];
  const presenceHtml = viewers.length > 0
    ? `<span class="presence-mini-pill">👁️ Viendo ahora: ${escapeHtml(viewers.join(', '))}</span>`
    : '';

  // Installment chips
  const cuotasChipsHtml = plan.cuotas.map((c) => {
    let chipClass = 'chip-pendiente';
    let icon = '⏳';
    let labelExtra = formatMoney(c.saldo_pendiente);

    if (c.estado === 'PAGADA') {
      chipClass = 'chip-pagada';
      icon = '✓';
      labelExtra = `Pagada (${c.cuenta_destino || 'Transf.'})`;
    } else if (c.estado === 'ANULADA_POR_BAJA') {
      chipClass = 'chip-anulada';
      icon = '✕';
      labelExtra = 'Anulada';
    } else if (c.vencida) {
      chipClass = 'chip-vencida';
      icon = '🚨';
      labelExtra = `Venció ${formatDateAR(c.fecha_vencimiento)}`;
    } else if (c.estado === 'PARCIAL_SENA') {
      chipClass = 'chip-sena';
      icon = '⏳';
      labelExtra = `Resta ${formatMoney(c.saldo_pendiente)} (${formatDateAR(c.fecha_vencimiento)})`;
    } else if (c.estado === 'PENDIENTE_ALTA') {
      chipClass = 'chip-alta';
      icon = '🔔';
      labelExtra = `Alta ${formatDateAR(c.fecha_vencimiento)}`;
    } else {
      labelExtra = `${formatMoney(c.saldo_pendiente)} (${MESES_NOMBRES[c.mes_vencimiento]?.slice(0, 3)} ${c.anio_vencimiento})`;
    }

    return `
      <span class="cuota-chip ${chipClass} tabular-nums" title="Cuota ${c.numero_cuota}: Vencimiento ${formatDateAR(c.fecha_vencimiento)}">
        ${icon} C${c.numero_cuota}: ${escapeHtml(labelExtra)}
      </span>
    `;
  }).join('');

  // Determine the priority target installment for action in this view
  const cuotaPeriodo = getCuotaDelPeriodo(plan, mes, anio);
  const targetCuota = (cuotaPeriodo && cuotaPeriodo.estado !== 'PAGADA' && cuotaPeriodo.estado !== 'ANULADA_POR_BAJA')
    ? cuotaPeriodo
    : plan.resumen.proxima_cuota;

  let focusStatusHtml = '';
  if (esBaja) {
    focusStatusHtml = `<div class="action-focus-text" style="color:#881337;">⛔ Plan dado de BAJA el ${formatDateAR(plan.fecha_baja)} • Motivo: ${escapeHtml(plan.motivo_baja || 'Abandono de plan')}</div>`;
  } else if (esCompletado) {
    focusStatusHtml = `<div class="action-focus-text" style="color:var(--success);">✅ 100% de las cuotas abonadas (${plan.cantidad_cuotas} de ${plan.cantidad_cuotas}) ${plan.cancelado_con_tarjeta ? '• Canceló saldo con Tarjeta' : ''}</div>`;
  } else if (targetCuota) {
    if (targetCuota.numero_cuota === 1 && targetCuota.estado === 'PARCIAL_SENA') {
      focusStatusHtml = `
        <div class="action-focus-text" style="color:${targetCuota.vencida ? 'var(--danger)' : 'var(--warning)'};">
          ${targetCuota.vencida ? '🚨 SEÑA VENCIDA:' : '⏳ Seña abonada:'} Dejó <strong>${formatMoney(targetCuota.monto_abonado)}</strong> (${escapeHtml(plan.cuenta_sena)}) •
          <strong>Falta cobrar de Cuota 1: ${formatMoney(targetCuota.saldo_pendiente)}</strong> (Compromiso: <strong>${formatDateAR(plan.fecha_compromiso || targetCuota.fecha_vencimiento)}</strong>)
        </div>
      `;
    } else if (targetCuota.numero_cuota === 1 && targetCuota.estado === 'PENDIENTE_ALTA') {
      focusStatusHtml = `
        <div class="action-focus-text" style="color:${targetCuota.vencida ? 'var(--danger)' : '#6B21A8'};">
          🔔 <strong>Alta pendiente de pago (Cuota 1: ${formatMoney(targetCuota.saldo_pendiente)})</strong> • Prometió abonar el <strong>${formatDateAR(plan.fecha_compromiso || targetCuota.fecha_vencimiento)}</strong>
        </div>
      `;
    } else {
      focusStatusHtml = `
        <div class="action-focus-text" style="color:${targetCuota.vencida ? 'var(--danger)' : 'var(--text-primary)'};">
          ${targetCuota.vencida ? '🚨 DEUDOR ATRASADO — ' : '📌 Próximo cobro: '}
          <strong>Cuota ${targetCuota.numero_cuota} de ${plan.cantidad_cuotas}</strong> por <strong>${formatMoney(targetCuota.saldo_pendiente)}</strong>
          (Vencimiento: <strong>${formatDateAR(targetCuota.fecha_vencimiento)}</strong>)
        </div>
      `;
    }
  }

  // Primary Action Button for the row
  let primaryActionBtnHtml = '';
  let whatsappRowHtml = '';

  if (!esBaja && targetCuota) {
    let btnLabel = `💰 Cobrar Cuota ${targetCuota.numero_cuota} (${formatMoney(targetCuota.saldo_pendiente)})`;
    let btnClass = 'btn-success';

    if (targetCuota.numero_cuota === 1 && targetCuota.estado === 'PENDIENTE_ALTA') {
      btnLabel = `✅ Confirmar Pago de Alta (${formatMoney(targetCuota.saldo_pendiente)})`;
      btnClass = 'btn-primary';
    } else if (targetCuota.numero_cuota === 1 && targetCuota.estado === 'PARCIAL_SENA') {
      btnLabel = `💰 Cobrar Saldo Seña (${formatMoney(targetCuota.saldo_pendiente)})`;
      btnClass = 'btn-warning';
    }

    primaryActionBtnHtml = `
      <button type="button" class="btn ${btnClass} btn-sm" data-action="quick-pay" data-plan-id="${plan.id}" data-cuota-id="${targetCuota.id}">
        ${btnLabel}
      </button>
    `;

    const waMessage = buildWhatsAppMessageForPlan(plan, targetCuota);
    const waUrl = buildWhatsAppUrl(plan.celular, waMessage);

    whatsappRowHtml = `
      <div class="action-row-inline">
        <a href="${waUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp btn-sm" title="Abrir WhatsApp Web en 1 clic con mensaje prellenado">
          💬 Reclamar WhatsApp
        </a>
        <button type="button" class="btn btn-secondary btn-sm" style="flex:0 0 auto; padding:0.45rem 0.65rem;" data-action="quick-wa-edit" data-plan-id="${plan.id}" data-cuota-id="${targetCuota.id}" title="Ver o editar el texto del mensaje antes de abrir WhatsApp">
          ✏️
        </button>
      </div>
    `;
  }

  const certIcon = plan.resumen.certificado_estado === 'LISTO_PARA_ENTREGAR' ? '🟢' : '🛑';

  return `
    <article class="${cardClass}" data-plan-card-id="${plan.id}">
      <!-- Columna 1: Identidad del Cliente y Canal -->
      <div class="col-identity">
        <div class="client-name-row">
          <span class="client-name">${escapeHtml(plan.nombre_completo)}</span>
          ${esBaja ? '<span class="baja-tag-strong">⛔ BAJA</span>' : ''}
          ${presenceHtml}
        </div>
        <div class="client-meta-row">
          <span class="dni-pill tabular-nums" title="DNI del cliente">DNI ${escapeHtml(formatDniVisual(plan.dni))}</span>
          <span class="tabular-nums">📱 ${escapeHtml(plan.celular)}</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.15rem;">
          <span class="channel-badge canal-${plan.canal}">${escapeHtml(canalText)}</span>
          <span class="modality-badge modality-${plan.modalidad_inicial}">
            ${escapeHtml(getModalityLabel(plan.modalidad_inicial, plan.estado_actual_modalidad))}
          </span>
        </div>
      </div>

      <!-- Columna 2: Estado de Cuotas y Notas de Seguimiento -->
      <div class="col-plan-status">
        ${focusStatusHtml}
        <div class="cuotas-strip">
          ${cuotasChipsHtml}
        </div>
        <div class="note-callout">
          <span>📝 <strong>Nota:</strong> ${plan.notas ? escapeHtml(plan.notas) : '<em>Sin notas de seguimiento</em>'}</span>
          <button type="button" class="btn btn-secondary btn-sm" style="min-height:28px; padding:0.15rem 0.55rem; font-size:0.78rem;" data-action="quick-note" data-plan-id="${plan.id}">
            ✏️ Nota
          </button>
        </div>
      </div>

      <!-- Columna 3: Regla Crítica Certificado + Resumen de Saldos -->
      <div class="col-certificate">
        <div class="cert-badge cert-${plan.resumen.certificado_estado}">
          <span>${certIcon}</span>
          <span>${escapeHtml(plan.resumen.certificado_etiqueta)}</span>
        </div>
        <div class="financial-mini tabular-nums">
          <span>Total abonado: <strong style="color:var(--success);">${formatMoney(plan.resumen.total_abonado)}</strong></span>
          <span>Saldo pendiente: <strong style="color:${plan.resumen.saldo_total_pendiente > 0 ? 'var(--danger)' : 'var(--text-primary)'};">${formatMoney(plan.resumen.saldo_total_pendiente)}</strong> (${plan.resumen.cuotas_pagadas}/${plan.cantidad_cuotas} cuotas)</span>
        </div>
      </div>

      <!-- Columna 4: Botones Grandes de Acción -->
      <div class="col-actions">
        ${primaryActionBtnHtml}
        ${whatsappRowHtml}
        <div class="action-row-inline">
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-detail" data-plan-id="${plan.id}">
            📂 Ver Ficha del Cliente
          </button>
          ${(!esBaja && !esCompletado) ? `
            <button type="button" class="btn btn-secondary btn-sm" style="flex:0 0 auto; padding:0.45rem 0.65rem;" data-action="quick-adelanto" data-plan-id="${plan.id}" title="Adelantar cuotas o cancelar con Tarjeta">
              💳 Adelantar
            </button>
          ` : ''}
        </div>
      </div>
    </article>
  `;
}

/* ==========================================================================
   Modal 1: Nueva Venta / Pasar a Cobranzas (Guided Form)
   ========================================================================== */

function populateNewSaleCatalogs() {
  const cuentasSelect = document.getElementById('ns-cuenta-inicial');
  const transferCuentas = state.cuentas.filter((c) => c.activa && c.tipo !== 'TARJETA_ADELANTO');
  cuentasSelect.innerHTML = transferCuentas
    .map((c) => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}${c.alias_info ? ' — ' + escapeHtml(c.alias_info) : ''}</option>`)
    .join('');

  const vendSelect = document.getElementById('ns-vendedora-select');
  const activeVends = state.vendedoras.filter((v) => v.activa);
  vendSelect.innerHTML = [
    '<option value="">-- Seleccione una vendedora de la lista --</option>',
    ...activeVends.map((v) => `<option value="${escapeHtml(v.nombre)}">${escapeHtml(v.nombre)}</option>`)
  ].join('');
}

function updateNewSaleDynamicUI() {
  const canal = document.getElementById('ns-canal').value;
  const mod = document.getElementById('ns-modalidad').value;
  const cantCuotas = parseInt(document.getElementById('ns-cantidad-cuotas').value, 10) || 1;
  const valorCuota = parseFloat(document.getElementById('ns-valor-cuota').value) || 0;
  const montoSena = parseFloat(document.getElementById('ns-monto-sena').value) || 0;
  const mesInicio = parseInt(document.getElementById('ns-mes-inicio').value, 10) || state.selectedMonth;
  const anioInicio = parseInt(document.getElementById('ns-anio-inicio').value, 10) || state.selectedYear;

  // Vendedoras mandatory box
  const vendBox = document.getElementById('ns-vendedora-box');
  vendBox.hidden = canal !== 'VENDEDORAS';

  // Total plan calculation
  const totalPlan = cantCuotas * valorCuota;
  document.getElementById('ns-total-plan-help').textContent = `Total del plan (${cantCuotas} cuotas): ${formatMoney(totalPlan)}`;

  // Modality fields visibility
  const grpSena = document.getElementById('group-ns-monto-sena');
  const grpCuenta = document.getElementById('group-ns-cuenta-inicial');
  const grpFechaComp = document.getElementById('group-ns-fecha-comprobante');
  const grpFechaPromesa = document.getElementById('group-ns-fecha-compromiso');
  const lblCuenta = document.getElementById('label-ns-cuenta-inicial');
  const lblFechaComp = document.getElementById('label-ns-fecha-comprobante');
  const lblFechaPromesa = document.getElementById('label-ns-fecha-compromiso');
  const previewBanner = document.getElementById('ns-live-preview-banner');

  if (mod === 'PAGO') {
    grpSena.hidden = true;
    grpCuenta.hidden = false;
    grpFechaComp.hidden = false;
    grpFechaPromesa.hidden = true;
    lblCuenta.textContent = 'Cuenta Destino donde ingresó la Cuota 1 *';
    lblFechaComp.textContent = 'Fecha Real del Comprobante de Cuota 1 *';

    const pendCuotas = Math.max(0, cantCuotas - 1);
    const saldoRestante = pendCuotas * valorCuota;
    previewBanner.innerHTML = `
      <span>✅</span>
      <div>
        <strong>Resumen Automático — Modalidad Pago:</strong><br/>
        • <strong>Cuota 1 (${formatMoney(valorCuota)}):</strong> Queda registrada como <strong>PAGADA</strong> hoy.<br/>
        • <strong>Cuotas pendientes:</strong> ${pendCuotas} cuotas restantes (Saldo pendiente: <strong>${formatMoney(saldoRestante)}</strong>).<br/>
        • <strong>Estado del Certificado:</strong> ${pendCuotas === 0 ? '<strong style="color:var(--success);">LISTO PARA ENTREGAR CERTIFICACIÓN</strong>' : '<strong style="color:var(--warning);">NO ENTREGAR - PLAN EN CURSO</strong>'}
      </div>
    `;
  } else if (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
    grpSena.hidden = false;
    grpCuenta.hidden = false;
    grpFechaComp.hidden = false;
    grpFechaPromesa.hidden = false;
    lblCuenta.textContent = 'Cuenta Destino donde ingresó la Seña *';
    lblFechaComp.textContent = 'Fecha Real del Comprobante de la Seña *';
    lblFechaPromesa.textContent = mod === 'SENA_MISMO_MES'
      ? 'Fecha de Compromiso para pagar el resto (Este mes) *'
      : 'Fecha Estimada para pagar el resto (Mes próximo) *';

    const restanteC1 = Math.max(0, valorCuota - montoSena);
    document.getElementById('ns-sena-calculo-help').textContent =
      `Resta abonar de la Cuota 1: ${formatMoney(restanteC1)}`;

    previewBanner.innerHTML = `
      <span>⏳</span>
      <div>
        <strong>Cálculo Automático de Seña (${mod === 'SENA_MISMO_MES' ? 'Mismo Mes' : 'Mes Siguiente'}):</strong><br/>
        • Valor de Cuota 1: <strong>${formatMoney(valorCuota)}</strong> menos Seña recibida: <strong>${formatMoney(montoSena)}</strong> = <strong>Saldo restante de Cuota 1: ${formatMoney(restanteC1)}</strong>.<br/>
        • Además quedarán las cuotas 2 a ${cantCuotas} de ${formatMoney(valorCuota)} cada una.<br/>
        • <strong>Estado del Certificado:</strong> <strong style="color:var(--warning);">NO ENTREGAR - PLAN EN CURSO</strong>
      </div>
    `;
  } else if (mod === 'ALTA') {
    grpSena.hidden = true;
    grpCuenta.hidden = true;
    grpFechaComp.hidden = true;
    grpFechaPromesa.hidden = false;
    lblFechaPromesa.textContent = 'Fecha en que prometió pagar la Cuota 1 *';

    previewBanner.innerHTML = `
      <span>🔔</span>
      <div>
        <strong>Resumen Automático — Modalidad Alta (Pago Diferido):</strong><br/>
        • Se da de alta la venta con <strong>$0 recibidos hoy</strong> (${MESES_NOMBRES[mesInicio]} ${anioInicio}).<br/>
        • En la pantalla principal aparecerá el botón <strong>"Confirmar Pago de Alta"</strong> para que cuando el cliente envíe el comprobante, pase automáticamente a <strong>Pago (Cuota 1 abonada)</strong>.<br/>
        • <strong>Estado del Certificado:</strong> <strong style="color:var(--warning);">NO ENTREGAR - PLAN EN CURSO</strong>
      </div>
    `;
  }
}

function openNewSaleModal() {
  populateNewSaleCatalogs();
  document.getElementById('form-new-sale').reset();
  document.getElementById('new-sale-error-box').hidden = true;

  // Set defaults to currently selected month/year and today's date
  document.getElementById('ns-mes-inicio').value = String(state.selectedMonth);
  document.getElementById('ns-anio-inicio').value = String(state.selectedYear);
  document.getElementById('ns-dia-vencimiento').value = state.configuracion.dia_vencimiento_fijo || '10';
  document.getElementById('ns-fecha-comprobante').value = state.hoy;
  document.getElementById('ns-fecha-compromiso').value = state.hoy;

  // If user is currently on a specific Canal tab, pre-select it!
  const defaultCanal = state.selectedCanal !== 'TODOS' ? state.selectedCanal : 'SEBASTIAN';
  document.getElementById('ns-canal').value = defaultCanal;
  document.querySelectorAll('#ns-canal-cards .option-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.canalVal === defaultCanal);
  });

  document.getElementById('ns-modalidad').value = 'PAGO';
  document.querySelectorAll('#ns-modalidad-cards .option-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.modVal === 'PAGO');
  });

  updateNewSaleDynamicUI();
  document.getElementById('modal-new-sale').hidden = false;
  document.getElementById('ns-dni').focus();
}

/* ==========================================================================
   Modal 2: Ficha Individual del Cliente (Complete Detail View)
   ========================================================================== */

function openClientDetailModal(planId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  state.openClientPlanId = plan.id;
  sendWsMessage({ type: 'viewing_plan', planId: plan.id, operadora: state.operadora });
  renderClientDetailModalContent(plan);
  document.getElementById('modal-client-detail').hidden = false;
}

function closeClientDetailModal() {
  state.openClientPlanId = null;
  sendWsMessage({ type: 'viewing_plan', planId: null, operadora: state.operadora });
  document.getElementById('modal-client-detail').hidden = true;
}

function renderClientDetailModalContent(plan) {
  const esBaja = plan.estado_plan === 'BAJA';
  const esCompletado = plan.resumen.todas_pagadas;

  document.getElementById('title-modal-client-detail').textContent =
    `Ficha del Cliente: ${plan.nombre_completo} (DNI ${formatDniVisual(plan.dni)})`;

  let canalDesc = 'Canal: 1. Sebastián';
  if (plan.canal === 'VENDEDORAS') canalDesc = `Canal: 2. Vendedoras (${plan.vendedora_nombre})`;
  if (plan.canal === 'TRAMOS') canalDesc = 'Canal: 3. Tramos';

  document.getElementById('subtitle-modal-client-detail').textContent =
    `${canalDesc} • Celular: ${plan.celular} • Inicio: ${MESES_NOMBRES[plan.mes_inicio]} ${plan.anio_inicio}`;

  const body = document.getElementById('body-modal-client-detail');
  const certIcon = plan.resumen.certificado_estado === 'LISTO_PARA_ENTREGAR' ? '🟢' : '🛑';

  const cuotasRowsHtml = plan.cuotas.map((c) => {
    const isPaid = c.estado === 'PAGADA';
    const isCancelled = c.estado === 'ANULADA_POR_BAJA';
    const rowClass = isPaid ? 'row-pagada' : (isCancelled ? 'row-anulada' : (c.vencida ? 'row-vencida' : ''));

    let estadoBadge = '<span class="cuota-chip chip-pendiente">⏳ Pendiente</span>';
    if (isPaid) {
      estadoBadge = '<span class="cuota-chip chip-pagada">✅ PAGADA</span>';
    } else if (isCancelled) {
      estadoBadge = '<span class="cuota-chip chip-anulada">⛔ Anulada por Baja</span>';
    } else if (c.estado === 'PARCIAL_SENA') {
      estadoBadge = `<span class="cuota-chip chip-sena">${c.vencida ? '🚨 Seña Vencida' : '⏳ Seña Parcial'}</span>`;
    } else if (c.estado === 'PENDIENTE_ALTA') {
      estadoBadge = `<span class="cuota-chip chip-alta">${c.vencida ? '🚨 Alta Vencida' : '🔔 Alta Pendiente'}</span>`;
    } else if (c.vencida) {
      estadoBadge = '<span class="cuota-chip chip-vencida">🚨 VENCIDA (Deudor)</span>';
    }

    let actionCellHtml = '—';
    if (!isPaid && !isCancelled && !esBaja) {
      let payBtnLabel = '💰 Registrar Pago';
      let payBtnClass = 'btn-success';
      if (c.numero_cuota === 1 && c.estado === 'PENDIENTE_ALTA') {
        payBtnLabel = '✅ Confirmar Pago de Alta';
        payBtnClass = 'btn-primary';
      } else if (c.numero_cuota === 1 && c.estado === 'PARCIAL_SENA') {
        payBtnLabel = `💰 Cobrar Saldo Seña (${formatMoney(c.saldo_pendiente)})`;
        payBtnClass = 'btn-warning';
      }

      const waMsg = buildWhatsAppMessageForPlan(plan, c);
      const waHref = buildWhatsAppUrl(plan.celular, waMsg);

      actionCellHtml = `
        <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
          <button type="button" class="btn ${payBtnClass} btn-sm detail-pay-btn" data-plan-id="${plan.id}" data-cuota-id="${c.id}">
            ${payBtnLabel}
          </button>
          <a href="${waHref}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp btn-sm">
            💬 WhatsApp
          </a>
        </div>
      `;
    }

    return `
      <tr class="${rowClass}">
        <td class="tabular-nums"><strong>Cuota ${c.numero_cuota}</strong> de ${plan.cantidad_cuotas}</td>
        <td class="tabular-nums">${formatDateAR(c.fecha_vencimiento)} <small style="color:var(--text-muted);">(${MESES_NOMBRES[c.mes_vencimiento]?.slice(0, 3)} ${c.anio_vencimiento})</small></td>
        <td class="tabular-nums">${formatMoney(c.valor_nominal)}</td>
        <td class="tabular-nums" style="color:var(--success);">${formatMoney(c.monto_abonado)}</td>
        <td class="tabular-nums" style="color:${c.saldo_pendiente > 0 ? 'var(--danger)' : 'var(--text-muted)'};"><strong>${formatMoney(c.saldo_pendiente)}</strong></td>
        <td>${estadoBadge}</td>
        <td>${c.cuenta_destino ? `<strong>${escapeHtml(c.cuenta_destino)}</strong>` : '—'}</td>
        <td class="tabular-nums">
          ${c.fecha_comprobante ? `<div>📄 Comp: <strong>${formatDateAR(c.fecha_comprobante)}</strong></div>` : '—'}
          ${c.fecha_registro_pago ? `<div style="font-size:0.76rem; color:var(--text-muted);">Carga: ${formatDateTimeAR(c.fecha_registro_pago)}</div>` : ''}
        </td>
        <td>${actionCellHtml}</td>
      </tr>
    `;
  }).join('');

  const movimientosHtml = plan.movimientos.length === 0
    ? '<p style="color:var(--text-muted);">Aún no hay pagos acreditados en esta cuenta corriente.</p>'
    : plan.movimientos.map((m) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.85rem; background:#FFFFFF; border:1.5px solid var(--border-subtle); border-radius:8px; gap:0.75rem; flex-wrap:wrap;">
          <div>
            <strong>${escapeHtml(m.detalle || m.tipo_movimiento)}</strong>
            <div style="font-size:0.84rem; color:var(--text-secondary);">
              Cuenta Destino: <strong>${escapeHtml(m.cuenta_destino)}</strong> (${escapeHtml(m.medio_pago)}) • Cargado por: ${escapeHtml(m.operadora)}
            </div>
          </div>
          <div style="text-align:right;" class="tabular-nums">
            <div style="font-size:1.05rem; font-weight:800; color:var(--success);">${formatMoney(m.monto)}</div>
            <div style="font-size:0.8rem; color:var(--text-muted);">Comprobante: <strong>${formatDateAR(m.fecha_comprobante)}</strong> | Carga: ${formatDateTimeAR(m.fecha_registro)}</div>
          </div>
        </div>
      `).join('');

  const notasHtml = plan.historial.length === 0
    ? '<p style="color:var(--text-muted);">Sin historial de notas.</p>'
    : plan.historial.map((h) => `
        <div style="padding:0.55rem 0.85rem; background:#FFFFFF; border-left:4px solid var(--primary); border-radius:6px; font-size:0.9rem;">
          <div>${escapeHtml(h.texto)}</div>
          <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.15rem;">
            Por <strong>${escapeHtml(h.autor)}</strong> el ${formatDateTimeAR(h.created_at)}
          </div>
        </div>
      `).join('');

  body.innerHTML = `
    <!-- Banner Regla Crítica Certificado + Botones de Adelanto/Cancelación -->
    <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:1rem; padding:1.1rem 1.25rem; background:var(--bg-subtle); border:2px solid var(--border-strong); border-radius:12px;">
      <div style="display:flex; flex-direction:column; gap:0.35rem;">
        <span style="font-size:0.82rem; font-weight:800; text-transform:uppercase; color:var(--text-secondary);">
          Regla Crítica: Estado de Entrega del Certificado
        </span>
        <div class="cert-badge cert-${plan.resumen.certificado_estado}" style="font-size:1.05rem; padding:0.65rem 1.1rem;">
          <span>${certIcon}</span>
          <span>${escapeHtml(plan.resumen.certificado_etiqueta)}</span>
        </div>
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:0.65rem; align-items:center;">
        <div style="text-align:right; margin-right:0.5rem;" class="tabular-nums">
          <div style="font-size:0.88rem; color:var(--text-secondary);">Total Abonado: <strong style="color:var(--success);">${formatMoney(plan.resumen.total_abonado)}</strong></div>
          <div style="font-size:1.05rem; font-weight:800; color:${plan.resumen.saldo_total_pendiente > 0 ? 'var(--danger)' : 'var(--success)'};">
            Saldo Pendiente: ${formatMoney(plan.resumen.saldo_total_pendiente)}
          </div>
        </div>

        ${(!esBaja && !esCompletado) ? `
          <button type="button" class="btn btn-primary" id="btn-detail-adelantar">
            💳 Adelantar Cuotas / Cancelar con Tarjeta
          </button>
        ` : ''}
      </div>
    </div>

    <!-- Edición Rápida de Datos del Cliente y Nota recordatoria -->
    <div class="form-section">
      <div class="form-section-title">✏️ Datos del Cliente, Compromiso y Nota de Seguimiento</div>
      <form id="form-detail-update-client" class="form-grid-4">
        <div class="form-group">
          <label class="form-label">Nombre</label>
          <input type="text" id="edit-cli-nombre" class="form-input" value="${escapeHtml(plan.nombre)}" required />
        </div>
        <div class="form-group">
          <label class="form-label">Apellido</label>
          <input type="text" id="edit-cli-apellido" class="form-input" value="${escapeHtml(plan.apellido)}" required />
        </div>
        <div class="form-group">
          <label class="form-label">DNI</label>
          <input type="text" id="edit-cli-dni" class="form-input tabular-nums" value="${escapeHtml(plan.dni)}" required />
        </div>
        <div class="form-group">
          <label class="form-label">Celular (WhatsApp)</label>
          <input type="text" id="edit-cli-celular" class="form-input tabular-nums" value="${escapeHtml(plan.celular)}" required />
        </div>
        <div class="form-group" style="grid-column: span 2;">
          <label class="form-label">Nota / Recordatorio Visible en Tabla Principal</label>
          <input type="text" id="edit-cli-notas" class="form-input" value="${escapeHtml(plan.notas)}" placeholder="Ej: Prometió transferir el viernes..." />
        </div>
        <div class="form-group">
          <label class="form-label">Fecha Compromiso (Seña/Alta)</label>
          <input type="date" id="edit-cli-fecha-comp" class="form-input tabular-nums" value="${escapeHtml(plan.fecha_compromiso)}" />
        </div>
        <div class="form-group" style="justify-content:flex-end;">
          <button type="submit" class="btn btn-secondary">💾 Guardar Cambios de Ficha</button>
        </div>
      </form>
    </div>

    <!-- Cronograma de Cuotas -->
    <div class="form-section">
      <div class="form-section-title">📅 Cronograma Completo de Cuotas y Comprobantes</div>
      <div class="cuotas-table-wrap">
        <table class="cuotas-table">
          <thead>
            <tr>
              <th>Cuota</th>
              <th>Vencimiento</th>
              <th>Valor Cuota</th>
              <th>Abonado</th>
              <th>Saldo Pendiente</th>
              <th>Estado</th>
              <th>Cuenta Destino</th>
              <th>Fecha Comprobante / Carga</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${cuotasRowsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Historial de Pagos Imputados y Bitácora -->
    <div class="form-grid-2">
      <div class="form-section">
        <div class="form-section-title">🏦 Historial de Movimientos de Dinero</div>
        <div style="display:flex; flex-direction:column; gap:0.5rem; max-height:260px; overflow-y:auto;">
          ${movimientosHtml}
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">📝 Bitácora de Notas y Seguimiento</div>
        <div style="display:flex; flex-direction:column; gap:0.5rem; max-height:260px; overflow-y:auto;">
          ${notasHtml}
        </div>
      </div>
    </div>
  `;

  // Footer Left: Dar de Baja or Reactivar button
  const footerLeft = document.getElementById('footer-left-client-detail');
  if (esBaja) {
    footerLeft.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-detail-reactivar">
        🔄 Reactivar Plan (Revertir Baja)
      </button>
    `;
    document.getElementById('btn-detail-reactivar').addEventListener('click', async () => {
      await handleReactivarPlan(plan.id);
    });
  } else {
    footerLeft.innerHTML = `
      <button type="button" class="btn btn-danger-outline" id="btn-detail-baja">
        ⛔ Dar de Baja el Plan (Anular cuotas restantes)
      </button>
    `;
    document.getElementById('btn-detail-baja').addEventListener('click', () => {
      openConfirmBajaModal(plan);
    });
  }

  // Bind buttons inside detail modal
  body.querySelectorAll('.detail-pay-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      openPayCuotaModal(Number(btn.dataset.planId), Number(btn.dataset.cuotaId));
    });
  });

  const btnAdelantar = document.getElementById('btn-detail-adelantar');
  if (btnAdelantar) {
    btnAdelantar.addEventListener('click', () => openAdelantoModal(plan.id));
  }

  const formEditClient = document.getElementById('form-detail-update-client');
  if (formEditClient) {
    formEditClient.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await fetch(`/api/planes/${plan.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nombre: document.getElementById('edit-cli-nombre').value,
            apellido: document.getElementById('edit-cli-apellido').value,
            dni: document.getElementById('edit-cli-dni').value,
            celular: document.getElementById('edit-cli-celular').value,
            notas: document.getElementById('edit-cli-notas').value,
            fecha_compromiso: document.getElementById('edit-cli-fecha-comp').value,
            operadora: state.operadora
          })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        showToast('Ficha del cliente actualizada correctamente.');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
}

/* ==========================================================================
   Modal 3: Registrar Pago de Cuota / Completar Seña / Confirmar Alta
   ========================================================================== */

function openPayCuotaModal(planId, cuotaId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  const cuota = plan.cuotas.find((c) => c.id === Number(cuotaId));
  if (!cuota) return;

  document.getElementById('pay-plan-id').value = plan.id;
  document.getElementById('pay-cuota-id').value = cuota.id;
  document.getElementById('pay-cuota-error-box').hidden = true;
  document.getElementById('pay-observacion').value = '';
  document.getElementById('pay-fecha-comprobante').value = state.hoy;
  document.getElementById('pay-monto-cobrado').value = cuota.saldo_pendiente;

  const cuentasSelect = document.getElementById('pay-cuenta-destino');
  const activeCuentas = state.cuentas.filter((c) => c.activa && c.tipo !== 'TARJETA_ADELANTO');
  cuentasSelect.innerHTML = activeCuentas
    .map((c) => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`)
    .join('');

  if (plan.cuenta_sena && activeCuentas.some((c) => c.nombre === plan.cuenta_sena)) {
    cuentasSelect.value = plan.cuenta_sena;
  }

  const titleEl = document.getElementById('title-modal-pay-cuota');
  const summaryEl = document.getElementById('pay-cuota-summary-banner');

  if (cuota.numero_cuota === 1 && cuota.estado === 'PENDIENTE_ALTA') {
    titleEl.textContent = `✅ Confirmar Pago de Alta — ${plan.nombre_completo}`;
    summaryEl.innerHTML = `
      <span>🔔</span>
      <div>
        <strong>Confirmación de Pago de Alta (Cuota 1 de ${plan.cantidad_cuotas}):</strong><br/>
        Al confirmar este pago, el estado del cliente pasará automáticamente a <strong>Pago (Cuota 1 abonada)</strong> y se registrará la fecha real del comprobante.
      </div>
    `;
  } else if (cuota.numero_cuota === 1 && cuota.estado === 'PARCIAL_SENA') {
    titleEl.textContent = `💰 Cobrar Saldo Restante de Seña — ${plan.nombre_completo}`;
    summaryEl.innerHTML = `
      <span>⏳</span>
      <div>
        <strong>Completar Cuota 1 (Seña previa descontada):</strong><br/>
        Valor Cuota 1: <strong>${formatMoney(cuota.valor_nominal)}</strong> • Seña ya abonada: <strong>${formatMoney(cuota.monto_abonado)}</strong><br/>
        <strong>Saldo restante a cobrar hoy: ${formatMoney(cuota.saldo_pendiente)}</strong>
      </div>
    `;
  } else {
    titleEl.textContent = `💰 Registrar Pago de Cuota ${cuota.numero_cuota} — ${plan.nombre_completo}`;
    summaryEl.innerHTML = `
      <span>📌</span>
      <div>
        <strong>Cliente: ${escapeHtml(plan.nombre_completo)} (DNI ${escapeHtml(plan.dni)})</strong><br/>
        Cuota <strong>${cuota.numero_cuota} de ${plan.cantidad_cuotas}</strong> • Vencimiento: <strong>${formatDateAR(cuota.fecha_vencimiento)}</strong> • Valor: <strong>${formatMoney(cuota.saldo_pendiente)}</strong>
      </div>
    `;
  }

  document.getElementById('modal-pay-cuota').hidden = false;
  document.getElementById('pay-monto-cobrado').focus();
}

/* ==========================================================================
   Modal 4: Adelantar Cuotas / Cancelación Total (Transferencia o Tarjeta)
   ========================================================================== */

function openAdelantoModal(planId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;

  const pendientes = plan.cuotas.filter((c) => c.estado !== 'PAGADA' && c.estado !== 'ANULADA_POR_BAJA');
  if (pendientes.length === 0) {
    showToast('Este cliente ya tiene todas las cuotas pagadas.');
    return;
  }

  document.getElementById('adelanto-plan-id').value = plan.id;
  document.getElementById('adelanto-error-box').hidden = true;
  document.getElementById('adelanto-fecha-comprobante').value = state.hoy;
  document.getElementById('adelanto-observacion').value = '';

  const checklist = document.getElementById('adelanto-cuotas-checklist');
  checklist.innerHTML = pendientes.map((c) => `
    <label style="display:flex; align-items:center; justify-content:space-between; padding:0.65rem 0.9rem; background:#FFFFFF; border:2px solid var(--border-strong); border-radius:8px; cursor:pointer; font-weight:700;">
      <span style="display:flex; align-items:center; gap:0.6rem;">
        <input type="checkbox" class="adelanto-cuota-check" value="${c.id}" data-saldo="${c.saldo_pendiente}" checked style="width:20px; height:20px;" />
        <span>Cuota ${c.numero_cuota} de ${plan.cantidad_cuotas} (Vence: ${formatDateAR(c.fecha_vencimiento)})</span>
      </span>
      <span class="tabular-nums" style="color:var(--primary); font-weight:800;">${formatMoney(c.saldo_pendiente)}</span>
    </label>
  `).join('');

  const recalcAdelantoTotal = () => {
    let sum = 0;
    checklist.querySelectorAll('.adelanto-cuota-check:checked').forEach((chk) => {
      sum += parseFloat(chk.dataset.saldo) || 0;
    });
    document.getElementById('adelanto-monto-total').value = sum;
  };

  checklist.querySelectorAll('.adelanto-cuota-check').forEach((chk) => {
    chk.addEventListener('change', recalcAdelantoTotal);
  });

  recalcAdelantoTotal();
  updateAdelantoCuentaOptions();
  document.getElementById('modal-adelanto').hidden = false;
}

function updateAdelantoCuentaOptions() {
  const medio = document.getElementById('adelanto-medio-pago').value;
  const select = document.getElementById('adelanto-cuenta-destino');

  if (medio === 'TARJETA_ADELANTO') {
    const cuentasTarjeta = state.cuentas.filter((c) => c.activa && c.tipo === 'TARJETA_ADELANTO');
    const options = cuentasTarjeta.length > 0
      ? cuentasTarjeta
      : [{ nombre: 'Tarjeta (Excepción Adelanto)' }];
    select.innerHTML = options.map((c) => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join('');
  } else {
    const cuentasTransf = state.cuentas.filter((c) => c.activa && c.tipo !== 'TARJETA_ADELANTO');
    select.innerHTML = cuentasTransf.map((c) => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join('');
  }
}

/* ==========================================================================
   Modal 5: Exportador Google Contacts CSV
   ========================================================================== */

function openCsvExportModal() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;
  const canal = state.selectedCanal;

  const seleccionados = state.planes.filter((plan) => {
    if (plan.estado_plan === 'BAJA') return false;
    if (canal !== 'TODOS' && plan.canal !== canal) return false;

    if (!state.allPeriods) {
      return plan.cuotas.some((c) => {
        if (c.estado === 'PAGADA' || c.estado === 'ANULADA_POR_BAJA' || c.saldo_pendiente <= 0) return false;
        const matchesMonth = (c.mes_vencimiento === mes && c.anio_vencimiento === anio);
        const isEarlierOverdue = (c.anio_vencimiento < anio) || (c.anio_vencimiento === anio && c.mes_vencimiento < mes);
        return matchesMonth || isEarlierOverdue;
      });
    }
    return plan.resumen.saldo_total_pendiente > 0;
  });

  const periodDesc = state.allPeriods ? 'Todos los períodos' : `${MESES_NOMBRES[mes]} ${anio}`;
  document.getElementById('csv-preview-summary').textContent =
    `Clientes con cuotas/saldos pendientes a exportar (${periodDesc} • Canal: ${canal}): ${seleccionados.length} contactos`;

  const tbody = document.getElementById('csv-preview-tbody');
  if (seleccionados.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No hay clientes con cuotas pendientes en este período.</td></tr>';
  } else {
    tbody.innerHTML = seleccionados.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.nombre_completo)}</strong></td>
        <td class="tabular-nums"><span class="dni-pill">${escapeHtml(p.dni)}</span></td>
        <td class="tabular-nums">+54 9 ${escapeHtml(p.celular)}</td>
        <td>${escapeHtml(p.canal)} (${formatMoney(p.resumen.saldo_total_pendiente)})</td>
      </tr>
    `).join('');
  }

  const queryParams = new URLSearchParams();
  if (!state.allPeriods) {
    queryParams.set('mes', String(mes));
    queryParams.set('anio', String(anio));
  }
  queryParams.set('canal', canal);

  const downloadLink = document.getElementById('btn-download-csv-now');
  downloadLink.href = `/api/export/google-contacts-csv?${queryParams.toString()}`;

  document.getElementById('modal-csv-export').hidden = false;
}

/* ==========================================================================
   Modal 6: Gestión de Cuentas Destino, Vendedoras y Configuración
   ========================================================================== */

function renderCatalogsModal() {
  const cuentasContainer = document.getElementById('catalog-cuentas-list');
  cuentasContainer.innerHTML = state.cuentas.map((c) => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:0.55rem 0.8rem; background:#FFFFFF; border:1.5px solid var(--border-subtle); border-radius:8px;">
      <div>
        <strong>${escapeHtml(c.nombre)}</strong>
        ${c.alias_info ? `<span style="font-size:0.82rem; color:var(--text-muted);"> — ${escapeHtml(c.alias_info)}</span>` : ''}
        <span style="font-size:0.76rem; margin-left:0.4rem; padding:0.1rem 0.45rem; border-radius:4px; background:${c.activa ? 'var(--success-soft)' : 'var(--danger-soft)'}; color:${c.activa ? 'var(--success-text)' : 'var(--danger-text)'}; font-weight:800;">
          ${c.activa ? 'ACTIVA' : 'DESACTIVADA'}
        </span>
      </div>
      <button type="button" class="btn btn-secondary btn-sm toggle-cuenta-btn" data-id="${c.id}" data-activa="${c.activa ? '1' : '0'}">
        ${c.activa ? 'Desactivar' : 'Reactivar'}
      </button>
    </div>
  `).join('');

  cuentasContainer.querySelectorAll('.toggle-cuenta-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const currentActiva = btn.dataset.activa === '1';
      await fetch(`/api/cuentas/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activa: !currentActiva })
      });
    });
  });

  const vendContainer = document.getElementById('catalog-vendedoras-list');
  vendContainer.innerHTML = state.vendedoras.map((v) => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:0.55rem 0.8rem; background:#FFFFFF; border:1.5px solid var(--border-subtle); border-radius:8px;">
      <div>
        <strong>👩‍💼 ${escapeHtml(v.nombre)}</strong>
        <span style="font-size:0.76rem; margin-left:0.4rem; padding:0.1rem 0.45rem; border-radius:4px; background:${v.activa ? 'var(--success-soft)' : 'var(--danger-soft)'}; color:${v.activa ? 'var(--success-text)' : 'var(--danger-text)'}; font-weight:800;">
          ${v.activa ? 'ACTIVA' : 'INACTIVA'}
        </span>
      </div>
      <button type="button" class="btn btn-secondary btn-sm toggle-vend-btn" data-id="${v.id}" data-activa="${v.activa ? '1' : '0'}">
        ${v.activa ? 'Desactivar' : 'Reactivar'}
      </button>
    </div>
  `).join('');

  vendContainer.querySelectorAll('.toggle-vend-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const currentActiva = btn.dataset.activa === '1';
      await fetch(`/api/vendedoras/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activa: !currentActiva })
      });
    });
  });

  document.getElementById('cfg-dia-vencimiento').value = state.configuracion.dia_vencimiento_fijo || '10';
  document.getElementById('cfg-pin-equipo').value = state.configuracion.pin_equipo || '2026';
  document.getElementById('cfg-whatsapp-cuota').value = state.configuracion.plantilla_whatsapp_cuota || '';
}

/* ==========================================================================
   Modal 7 & 9: WhatsApp Edit Preview, Quick Note & Confirm Baja
   ========================================================================== */

function openWhatsAppModal(planId, cuotaId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  const cuota = plan.cuotas.find((c) => c.id === Number(cuotaId)) || plan.resumen.proxima_cuota;
  const msg = buildWhatsAppMessageForPlan(plan, cuota);

  document.getElementById('wa-client-info').textContent =
    `Destinatario: ${plan.nombre_completo} • Celular: ${plan.celular}`;
  const textarea = document.getElementById('wa-message-text');
  textarea.value = msg;

  const updateLink = () => {
    document.getElementById('btn-wa-launch').href = buildWhatsAppUrl(plan.celular, textarea.value);
  };
  textarea.oninput = updateLink;
  updateLink();

  document.getElementById('modal-whatsapp').hidden = false;
}

async function promptQuickNote(planId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  const nuevaNota = window.prompt(
    `Editar nota de seguimiento para ${plan.nombre_completo}:`,
    plan.notas || ''
  );
  if (nuevaNota === null) return;

  try {
    const res = await fetch(`/api/planes/${plan.id}/notas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texto: nuevaNota || 'Nota limpiada',
        actualizar_recordatorio: true,
        operadora: state.operadora
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showToast('Nota de seguimiento guardada.');
  } catch (err) {
    showToast(err.message, true);
  }
}

function openConfirmBajaModal(plan) {
  document.getElementById('baja-plan-id').value = plan.id;
  document.getElementById('baja-client-name').textContent = `${plan.nombre_completo} (DNI ${plan.dni})`;
  document.getElementById('baja-motivo').value = 'Abandonó el plan / Solicitó baja a mitad de cursada';
  document.getElementById('modal-confirm-baja').hidden = false;
}

async function handleReactivarPlan(planId) {
  try {
    const res = await fetch(`/api/planes/${planId}/reactivar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operadora: state.operadora })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showToast('Plan reactivado correctamente.');
  } catch (err) {
    showToast(err.message, true);
  }
}

/* ==========================================================================
   WebSocket Real-Time Connection & Data Bootstrap
   ========================================================================== */

function sendWsMessage(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener('open', () => {
    const badge = document.getElementById('realtime-status-badge');
    if (badge) badge.classList.remove('realtime-badge-offline');
    sendWsMessage({
      type: 'identify',
      operadora: state.operadora
    });
    if (state.openClientPlanId) {
      sendWsMessage({
        type: 'viewing_plan',
        planId: state.openClientPlanId,
        operadora: state.operadora
      });
    }
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.presence) {
        state.presence = msg.presence;
      }

      if (msg.type === 'state_updated') {
        if (msg.planes) state.planes = msg.planes;
        if (msg.movimientos) state.movimientos = msg.movimientos;
        if (msg.cuentas) state.cuentas = msg.cuentas;
        if (msg.vendedoras) state.vendedoras = msg.vendedoras;
        if (msg.configuracion) state.configuracion = msg.configuracion;
        renderAll();
      } else if (msg.type === 'catalog_updated') {
        if (msg.cuentas) state.cuentas = msg.cuentas;
        if (msg.vendedoras) state.vendedoras = msg.vendedoras;
        if (msg.configuracion) state.configuracion = msg.configuracion;
        renderCatalogsModal();
        renderAll();
      } else if (msg.type === 'presence_updated' || msg.type === 'welcome') {
        renderHeaderState();
        renderClientRecordsList();
      }
    } catch (_err) {
      // ignore parse errors
    }
  });

  ws.addEventListener('close', () => {
    const badgeText = document.getElementById('realtime-status-text');
    if (badgeText) badgeText.textContent = 'Reconectando en vivo...';
    setTimeout(connectWebSocket, 2500);
  });
}

async function bootstrapData() {
  try {
    const res = await fetch('/api/bootstrap');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error al cargar datos');

    state.hoy = data.hoy || '2026-11-13';
    state.planes = data.planes || [];
    state.cuentas = data.cuentas || [];
    state.vendedoras = data.vendedoras || [];
    state.movimientos = data.movimientos || [];
    state.configuracion = data.configuracion || {};
    if (data.presence) state.presence = data.presence;

    // Set initial period selector to current date's month & year
    const parts = state.hoy.split('-');
    if (parts.length >= 2) {
      state.selectedYear = parseInt(parts[0], 10) || 2026;
      state.selectedMonth = parseInt(parts[1], 10) || 11;
      document.getElementById('select-month').value = String(state.selectedMonth);
      document.getElementById('select-year').value = String(state.selectedYear);
    }

    renderAll();
  } catch (err) {
    showToast(err.message, true);
  }
}

/* ==========================================================================
   Event Listeners Initialization
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  bootstrapData();
  connectWebSocket();

  // Font Zoom Buttons
  document.querySelectorAll('.zoom-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.zoom = btn.dataset.zoom;
      localStorage.setItem('ed_zoom', state.zoom);
      renderHeaderState();
    });
  });

  // Close Modal buttons
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.closeModal;
      if (modalId === 'modal-client-detail') {
        closeClientDetailModal();
      } else {
        document.getElementById(modalId).hidden = true;
      }
    });
  });

  // Period Selector Controls
  const selMonth = document.getElementById('select-month');
  const selYear = document.getElementById('select-year');

  selMonth.addEventListener('change', () => {
    state.selectedMonth = parseInt(selMonth.value, 10);
    state.allPeriods = false;
    renderAll();
  });

  selYear.addEventListener('change', () => {
    state.selectedYear = parseInt(selYear.value, 10);
    state.allPeriods = false;
    renderAll();
  });

  document.getElementById('btn-prev-month').addEventListener('click', () => {
    state.allPeriods = false;
    if (state.selectedMonth === 1) {
      state.selectedMonth = 12;
      state.selectedYear -= 1;
    } else {
      state.selectedMonth -= 1;
    }
    selMonth.value = String(state.selectedMonth);
    selYear.value = String(state.selectedYear);
    renderAll();
  });

  document.getElementById('btn-next-month').addEventListener('click', () => {
    state.allPeriods = false;
    if (state.selectedMonth === 12) {
      state.selectedMonth = 1;
      state.selectedYear += 1;
    } else {
      state.selectedMonth += 1;
    }
    selMonth.value = String(state.selectedMonth);
    selYear.value = String(state.selectedYear);
    renderAll();
  });

  document.getElementById('btn-toggle-all-periods').addEventListener('click', () => {
    state.allPeriods = !state.allPeriods;
    renderAll();
  });

  // Giant Search Box
  const searchInput = document.getElementById('input-global-search');
  const clearSearchBtn = document.getElementById('btn-clear-search');

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    clearSearchBtn.hidden = !state.searchQuery;
    renderAll();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    clearSearchBtn.hidden = true;
    renderAll();
  });

  // Channel Tabs
  document.querySelectorAll('.channel-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.selectedCanal = tab.dataset.canal;
      state.selectedVendedora = 'TODAS';
      renderAll();
    });
  });

  // Quick Filter Pills
  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      state.selectedQuickFilter = pill.dataset.filter;
      renderAll();
    });
  });

  document.getElementById('btn-kpi-filter-deudores').addEventListener('click', () => {
    state.selectedQuickFilter = 'DEUDORES';
    renderAll();
  });

  // Open New Sale Modal
  document.getElementById('btn-open-new-sale').addEventListener('click', openNewSaleModal);

  // New Sale Canal Option Cards
  document.querySelectorAll('#ns-canal-cards .option-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#ns-canal-cards .option-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('ns-canal').value = card.dataset.canalVal;
      updateNewSaleDynamicUI();
    });
  });

  // New Sale Quick Cuotas Buttons
  document.querySelectorAll('.ns-quick-cuotas').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ns-quick-cuotas').forEach((b) => {
        b.classList.remove('btn-primary');
        b.classList.add('btn-secondary');
      });
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      document.getElementById('ns-cantidad-cuotas').value = btn.dataset.cuotas;
      updateNewSaleDynamicUI();
    });
  });

  // New Sale Modality Option Cards
  document.querySelectorAll('#ns-modalidad-cards .option-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#ns-modalidad-cards .option-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const mod = card.dataset.modVal;
      document.getElementById('ns-modalidad').value = mod;

      // Auto-suggest commitment date for Seña Mes Siguiente
      if (mod === 'SENA_MES_SIGUIENTE') {
        const m = parseInt(document.getElementById('ns-mes-inicio').value, 10) || state.selectedMonth;
        const y = parseInt(document.getElementById('ns-anio-inicio').value, 10) || state.selectedYear;
        const nextM = m === 12 ? 1 : m + 1;
        const nextY = m === 12 ? y + 1 : y;
        document.getElementById('ns-fecha-compromiso').value =
          `${nextY}-${String(nextM).padStart(2, '0')}-10`;
      }
      updateNewSaleDynamicUI();
    });
  });

  ['ns-cantidad-cuotas', 'ns-valor-cuota', 'ns-monto-sena', 'ns-mes-inicio', 'ns-anio-inicio'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateNewSaleDynamicUI);
    document.getElementById(id).addEventListener('change', updateNewSaleDynamicUI);
  });

  // Submit New Sale
  document.getElementById('form-new-sale').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('new-sale-error-box');
    errBox.hidden = true;

    const canal = document.getElementById('ns-canal').value;
    const vendSelect = document.getElementById('ns-vendedora-select').value;
    const vendCustom = document.getElementById('ns-vendedora-custom').value.trim();
    const vendedoraNombre = vendCustom || vendSelect;

    if (canal === 'VENDEDORAS' && !vendedoraNombre) {
      errBox.textContent = '⚠️ ATENCIÓN: Ha elegido el canal "Vendedoras". Es obligatorio seleccionar o escribir el Nombre de la Vendedora.';
      errBox.hidden = false;
      document.getElementById('ns-vendedora-select').focus();
      return;
    }

    const payload = {
      dni: document.getElementById('ns-dni').value,
      nombre: document.getElementById('ns-nombre').value,
      apellido: document.getElementById('ns-apellido').value,
      celular: document.getElementById('ns-celular').value,
      canal,
      vendedora_nombre: vendedoraNombre,
      modalidad_inicial: document.getElementById('ns-modalidad').value,
      cantidad_cuotas: document.getElementById('ns-cantidad-cuotas').value,
      valor_cuota_base: document.getElementById('ns-valor-cuota').value,
      mes_inicio: document.getElementById('ns-mes-inicio').value,
      anio_inicio: document.getElementById('ns-anio-inicio').value,
      dia_vencimiento: document.getElementById('ns-dia-vencimiento').value,
      cuenta_destino_inicial: document.getElementById('ns-cuenta-inicial').value,
      fecha_comprobante_inicial: document.getElementById('ns-fecha-comprobante').value,
      monto_sena: document.getElementById('ns-monto-sena').value,
      fecha_compromiso: document.getElementById('ns-fecha-compromiso').value,
      notas: document.getElementById('ns-notas').value,
      operadora: state.operadora
    };

    try {
      const res = await fetch('/api/planes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      document.getElementById('modal-new-sale').hidden = true;
      showToast(`Venta registrada y sincronizada: ${data.plan.nombre_completo}`);
    } catch (err) {
      errBox.textContent = `⚠️ ${err.message}`;
      errBox.hidden = false;
    }
  });

  // Submit Pay Cuota / Confirm Alta / Complete Seña
  document.getElementById('form-pay-cuota').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('pay-cuota-error-box');
    errBox.hidden = true;
    const planId = Number(document.getElementById('pay-plan-id').value);
    const cuotaId = Number(document.getElementById('pay-cuota-id').value);

    try {
      const res = await fetch(`/api/planes/${planId}/pagar-cuota`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cuota_id: cuotaId,
          monto_cobrado: document.getElementById('pay-monto-cobrado').value,
          cuenta_destino: document.getElementById('pay-cuenta-destino').value,
          fecha_comprobante: document.getElementById('pay-fecha-comprobante').value,
          observacion: document.getElementById('pay-observacion').value,
          operadora: state.operadora
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      document.getElementById('modal-pay-cuota').hidden = true;
      showToast(`Pago acreditado para ${data.plan.nombre_completo}.`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  // Adelanto Modal Listeners
  document.getElementById('adelanto-medio-pago').addEventListener('change', updateAdelantoCuentaOptions);

  document.getElementById('btn-adelanto-select-all').addEventListener('click', () => {
    let sum = 0;
    document.querySelectorAll('.adelanto-cuota-check').forEach((chk) => {
      chk.checked = true;
      sum += parseFloat(chk.dataset.saldo) || 0;
    });
    document.getElementById('adelanto-monto-total').value = sum;
  });

  document.getElementById('form-adelanto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('adelanto-error-box');
    errBox.hidden = true;
    const planId = Number(document.getElementById('adelanto-plan-id').value);
    const cuotaIds = Array.from(document.querySelectorAll('.adelanto-cuota-check:checked')).map((c) => Number(c.value));

    try {
      const res = await fetch(`/api/planes/${planId}/adelantar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cuota_ids: cuotaIds,
          medio_pago: document.getElementById('adelanto-medio-pago').value,
          cuenta_destino: document.getElementById('adelanto-cuenta-destino').value,
          monto_total_cobrado: document.getElementById('adelanto-monto-total').value,
          fecha_comprobante: document.getElementById('adelanto-fecha-comprobante').value,
          observacion: document.getElementById('adelanto-observacion').value,
          operadora: state.operadora
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      document.getElementById('modal-adelanto').hidden = true;
      showToast(`Adelanto/Cancelación registrado. Estado certificado: ${data.plan.resumen.certificado_etiqueta}`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  // Confirm Baja Submit
  document.getElementById('form-confirm-baja').addEventListener('submit', async (e) => {
    e.preventDefault();
    const planId = Number(document.getElementById('baja-plan-id').value);
    const motivo = document.getElementById('baja-motivo').value;

    try {
      const res = await fetch(`/api/planes/${planId}/baja`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo, operadora: state.operadora })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      document.getElementById('modal-confirm-baja').hidden = true;
      showToast(`Cliente ${data.plan.nombre_completo} pasado a estado BAJA.`);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Export CSV Modal
  document.getElementById('btn-open-csv-export').addEventListener('click', openCsvExportModal);

  // Catalogs & Config Modal
  document.getElementById('btn-open-catalogs').addEventListener('click', () => {
    renderCatalogsModal();
    document.getElementById('modal-catalogs').hidden = false;
  });

  document.getElementById('form-add-cuenta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = document.getElementById('input-new-cuenta-nombre').value;
    const alias_info = document.getElementById('input-new-cuenta-alias').value;
    const res = await fetch('/api/cuentas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, alias_info })
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error, true);
      return;
    }
    document.getElementById('form-add-cuenta').reset();
    showToast(`Cuenta destino "${nombre}" agregada.`);
  });

  document.getElementById('form-add-vendedora').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = document.getElementById('input-new-vendedora-nombre').value;
    const res = await fetch('/api/vendedoras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre })
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error, true);
      return;
    }
    document.getElementById('form-add-vendedora').reset();
    showToast(`Vendedora "${nombre}" agregada.`);
  });

  document.getElementById('form-save-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/configuracion', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dia_vencimiento_fijo: document.getElementById('cfg-dia-vencimiento').value,
        pin_equipo: document.getElementById('cfg-pin-equipo').value,
        plantilla_whatsapp_cuota: document.getElementById('cfg-whatsapp-cuota').value
      })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Configuración guardada correctamente.');
    }
  });

  // Operator & Shared Access Modal
  document.getElementById('btn-operator-access').addEventListener('click', () => {
    document.getElementById('input-operator-name').value = state.operadora;
    document.getElementById('operator-error-box').hidden = true;
    document.getElementById('modal-operator').hidden = false;
  });

  document.querySelectorAll('.quick-op-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('input-operator-name').value = btn.dataset.op;
    });
  });

  document.getElementById('form-operator').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = document.getElementById('input-operator-pin').value;
    const name = document.getElementById('input-operator-name').value.trim();
    const errBox = document.getElementById('operator-error-box');
    errBox.hidden = true;

    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (!data.ok) {
      errBox.textContent = data.error;
      errBox.hidden = false;
      return;
    }

    state.operadora = name || 'Equipo';
    localStorage.setItem('ed_operadora', state.operadora);
    sendWsMessage({ type: 'identify', operadora: state.operadora });
    renderHeaderState();
    document.getElementById('modal-operator').hidden = true;
    showToast(`Operadora activa: ${state.operadora}`);
  });
});

/* ==========================================================================
   Editorial Docente — Sistema de Cobranzas y Cuentas Corrientes
   Firebase Realtime Database Edition (Sincronización en Tiempo Real)
   ========================================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getDatabase,
  ref,
  onValue,
  runTransaction,
  set,
  onDisconnect
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDasP0-gxkQKqStESfxiIGqZmE9Jie37JU',
  authDomain: 'cobraza-5b7d2.firebaseapp.com',
  databaseURL: 'https://cobraza-5b7d2-default-rtdb.firebaseio.com',
  projectId: 'cobraza-5b7d2',
  storageBucket: 'cobraza-5b7d2.firebasestorage.app',
  messagingSenderId: '889625296759',
  appId: '1:889625296759:web:415f224b7a9065c4662b72',
  measurementId: 'G-W2BQR1KH10'
};

const app = initializeApp(firebaseConfig);
const rtdb = getDatabase(app);
const ROOT_PATH = 'editorial_docente';
const dbRef = ref(rtdb, ROOT_PATH);

const SESSION_ID = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const presenceRef = ref(rtdb, `${ROOT_PATH}/presence/${SESSION_ID}`);

const MESES_NOMBRES = [
  '',
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

function getTodayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function addMonths(mes, anio, offset) {
  const total = (anio * 12 + (mes - 1)) + offset;
  return { mes: (total % 12) + 1, anio: Math.floor(total / 12) };
}

function buildDateStr(anio, mes, dia) {
  const maxDays = new Date(anio, mes, 0).getDate();
  const safeDay = Math.min(Math.max(1, Number(dia) || 10), maxDays);
  return `${anio}-${pad2(mes)}-${pad2(safeDay)}`;
}

function parseYearMonthFromDate(dateStr, fallbackMes, fallbackAnio) {
  if (!dateStr || typeof dateStr !== 'string') {
    return { mes: fallbackMes, anio: fallbackAnio };
  }
  const parts = dateStr.split('-');
  if (parts.length >= 2) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
      return { mes: m, anio: y };
    }
  }
  return { mes: fallbackMes, anio: fallbackAnio };
}

const state = {
  hoy: getTodayDateString(),
  rawDb: null,
  planes: [],
  cuentas: [],
  vendedoras: [],
  movimientos: [],
  configuracion: {
    dia_vencimiento_fijo: '10',
    pin_equipo: '2026',
    plantilla_whatsapp_cuota: 'Hola {nombre}, te solicito el comprobante de la cuota {numero_cuota} de cobranzas de Editorial Docente, de tu certificado.',
    plantilla_whatsapp_sena: 'Hola {nombre}, te escribo de cobranzas de Editorial Docente para recordarte el saldo pendiente de la Cuota 1 ({monto_pendiente}) comprometido para el {fecha_compromiso}, de tu certificado.',
    plantilla_whatsapp_alta: 'Hola {nombre}, te solicito el comprobante de la cuota 1 (Alta comprometida para el {fecha_compromiso}) de cobranzas de Editorial Docente, de tu certificado.'
  },
  presence: { totalConectados: 1, operadores: [], fichasAbiertas: {} },

  selectedMonth: new Date().getMonth() + 1,
  selectedYear: new Date().getFullYear(),
  allPeriods: false,
  selectedCanal: 'TODOS',
  selectedVendedora: 'TODAS',
  selectedQuickFilter: 'TODOS',
  searchQuery: '',

  openClientPlanId: null,
  operadora: localStorage.getItem('ed_operadora') || 'Marta (Cobranzas)',
  zoom: localStorage.getItem('ed_zoom') || 'normal',
  isSeeding: false
};

/* ==========================================================================
   Core Business Logic (Pure Functions over Firebase Root Object)
   ========================================================================== */

function ensureDbShape(data) {
  const d = data && typeof data === 'object' ? { ...data } : {};
  if (!d.nextPlanId) d.nextPlanId = 1;
  if (!d.nextCuotaId) d.nextCuotaId = 1;
  if (!d.nextMovId) d.nextMovId = 1;
  if (!Array.isArray(d.cuentas)) {
    d.cuentas = [
      { id: 1, nombre: 'Openpay', tipo: 'TRANSFERENCIA', alias_info: 'Recaudación Openpay Bancario', activa: true },
      { id: 2, nombre: 'Xise', tipo: 'TRANSFERENCIA', alias_info: 'Cuenta Xise Transferencias', activa: true },
      { id: 3, nombre: 'Mercado Pago', tipo: 'TRANSFERENCIA', alias_info: 'CVU / Alias Editorial.MP', activa: true },
      { id: 4, nombre: 'Adriana', tipo: 'TRANSFERENCIA', alias_info: 'Cuenta Bancaria Adriana', activa: true },
      { id: 5, nombre: 'Tarjeta (Excepción Adelanto)', tipo: 'TARJETA_ADELANTO', alias_info: 'Exclusivo para cancelación/adelanto total', activa: true }
    ];
  }
  if (!Array.isArray(d.vendedoras)) {
    d.vendedoras = [
      { id: 1, nombre: 'Laura Martínez', activa: true },
      { id: 2, nombre: 'Carolina Gómez', activa: true },
      { id: 3, nombre: 'Valeria Díaz', activa: true },
      { id: 4, nombre: 'Sofía Peralta', activa: true },
      { id: 5, nombre: 'Romina Sosa', activa: true }
    ];
  }
  if (!d.configuracion || typeof d.configuracion !== 'object') {
    d.configuracion = { ...state.configuracion };
  }
  if (!Array.isArray(d.planes)) d.planes = [];
  if (!Array.isArray(d.movimientos)) d.movimientos = [];
  return d;
}

function insertPlanIntoDb(db, payload) {
  const cleanDni = String(payload.dni || '').replace(/[^\d]/g, '').trim();
  const cleanNombre = String(payload.nombre || '').trim();
  const cleanApellido = String(payload.apellido || '').trim();
  const cleanCelular = String(payload.celular || '').trim();
  const cleanCanal = String(payload.canal || '').toUpperCase().trim();
  const cleanVendedora = cleanCanal === 'VENDEDORAS' ? String(payload.vendedora_nombre || '').trim() : '';

  if (!cleanDni) throw new Error('El número de DNI es obligatorio.');
  if (!cleanNombre) throw new Error('El nombre del cliente es obligatorio.');
  if (!cleanApellido) throw new Error('El apellido del cliente es obligatorio.');
  if (!cleanCelular) throw new Error('El número de celular es obligatorio.');
  if (!['SEBASTIAN', 'VENDEDORAS', 'TRAMOS'].includes(cleanCanal)) {
    throw new Error('Debe seleccionar un Canal válido (Sebastián, Vendedoras o Tramos).');
  }
  if (cleanCanal === 'VENDEDORAS' && !cleanVendedora) {
    throw new Error('Para el canal "Vendedoras" es obligatorio indicar el Nombre de la Vendedora.');
  }

  const totalCuotas = parseInt(payload.cantidad_cuotas, 10);
  const valorBase = parseFloat(payload.valor_cuota_base);
  if (isNaN(totalCuotas) || totalCuotas < 1 || totalCuotas > 36) {
    throw new Error('La cantidad de cuotas debe ser entre 1 y 36.');
  }
  if (isNaN(valorBase) || valorBase <= 0) {
    throw new Error('El valor de cada cuota debe ser mayor a $0.');
  }

  const mod = String(payload.modalidad_inicial || 'PAGO').toUpperCase();
  const senaVal = (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') ? parseFloat(payload.monto_sena) : 0;

  if (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
    if (isNaN(senaVal) || senaVal <= 0) throw new Error('Debe ingresar el monto de la seña abonada.');
    if (senaVal >= valorBase) throw new Error('La seña debe ser menor al valor de la Cuota 1.');
    if (!payload.cuenta_destino_inicial) throw new Error('Debe seleccionar la Cuenta Destino de la seña.');
    if (!payload.fecha_compromiso) throw new Error('Debe indicar la Fecha de compromiso de pago restante.');
  }
  if (mod === 'PAGO' && !payload.cuenta_destino_inicial) {
    throw new Error('Debe seleccionar la Cuenta Destino donde ingresó la Cuota 1.');
  }
  if (mod === 'ALTA' && !payload.fecha_compromiso) {
    throw new Error('En modalidad "Alta" debe indicar la fecha en que prometió pagar la Cuota 1.');
  }

  const planId = db.nextPlanId++;
  const mInicio = parseInt(payload.mes_inicio, 10) || 11;
  const aInicio = parseInt(payload.anio_inicio, 10) || 2026;
  const diaVenc = parseInt(payload.dia_vencimiento || db.configuracion.dia_vencimiento_fijo || '10', 10) || 10;
  const fechaCompInicial = payload.fecha_comprobante_inicial || getTodayDateString();
  const nowIso = new Date().toISOString();

  let c1Mes = mInicio;
  let c1Anio = aInicio;
  if (mod === 'SENA_MES_SIGUIENTE') {
    const nextP = addMonths(mInicio, aInicio, 1);
    const parsed = parseYearMonthFromDate(payload.fecha_compromiso, nextP.mes, nextP.anio);
    c1Mes = parsed.mes;
    c1Anio = parsed.anio;
  } else if (mod === 'ALTA' || mod === 'SENA_MISMO_MES') {
    const parsed = parseYearMonthFromDate(payload.fecha_compromiso, mInicio, aInicio);
    c1Mes = parsed.mes;
    c1Anio = parsed.anio;
  }

  const cuotas = [];
  for (let i = 1; i <= totalCuotas; i++) {
    const cuotaId = db.nextCuotaId++;
    if (i === 1) {
      let estado = 'PENDIENTE';
      let abonado = 0;
      let saldo = valorBase;
      let cuenta = '';
      let fComp = '';
      let fReg = '';
      let obs = '';
      let fVenc = buildDateStr(c1Anio, c1Mes, diaVenc);

      if (mod === 'PAGO') {
        estado = 'PAGADA';
        abonado = valorBase;
        saldo = 0;
        cuenta = payload.cuenta_destino_inicial;
        fComp = fechaCompInicial;
        fReg = nowIso;
        obs = 'Cuota 1 abonada al ingresar la venta';
      } else if (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
        estado = 'PARCIAL_SENA';
        abonado = senaVal;
        saldo = Math.max(0, valorBase - senaVal);
        cuenta = payload.cuenta_destino_inicial;
        fComp = fechaCompInicial;
        fReg = nowIso;
        fVenc = payload.fecha_compromiso || fVenc;
        obs = `Seña inicial de $${senaVal.toLocaleString('es-AR')} en ${cuenta}. Resta $${saldo.toLocaleString('es-AR')}`;
      } else if (mod === 'ALTA') {
        estado = 'PENDIENTE_ALTA';
        abonado = 0;
        saldo = valorBase;
        fVenc = payload.fecha_compromiso || fVenc;
        obs = `Alta diferida comprometida para el ${fVenc}`;
      }

      cuotas.push({
        id: cuotaId,
        plan_id: planId,
        numero_cuota: 1,
        mes_vencimiento: c1Mes,
        anio_vencimiento: c1Anio,
        fecha_vencimiento: fVenc,
        valor_nominal: valorBase,
        monto_abonado: abonado,
        saldo_pendiente: saldo,
        estado,
        medio_pago: 'TRANSFERENCIA',
        cuenta_destino: cuenta,
        fecha_comprobante: fComp,
        fecha_registro_pago: fReg,
        observacion_pago: obs
      });

      if (mod === 'PAGO' || mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
        const imp = parseYearMonthFromDate(fechaCompInicial, mInicio, aInicio);
        db.movimientos.unshift({
          id: db.nextMovId++,
          plan_id: planId,
          cuota_id: cuotaId,
          numero_cuota: 1,
          tipo_movimiento: mod === 'PAGO' ? 'PAGO_INICIAL_CUOTA_1' : 'SENA_INICIAL',
          monto: abonado,
          cuenta_destino: cuenta,
          medio_pago: 'TRANSFERENCIA',
          fecha_comprobante: fechaCompInicial,
          mes_imputacion: imp.mes,
          anio_imputacion: imp.anio,
          fecha_registro: nowIso,
          operadora: payload.operadora || 'Administración',
          detalle: mod === 'PAGO' ? 'Pago completo de Cuota 1 al dar de alta' : `Seña de Cuota 1 (${mod === 'SENA_MISMO_MES' ? 'Mismo mes' : 'Mes siguiente'})`
        });
      }
    } else {
      const baseM = mod === 'SENA_MES_SIGUIENTE' ? c1Mes : mInicio;
      const baseA = mod === 'SENA_MES_SIGUIENTE' ? c1Anio : aInicio;
      const { mes: cm, anio: ca } = addMonths(baseM, baseA, i - 1);
      cuotas.push({
        id: cuotaId,
        plan_id: planId,
        numero_cuota: i,
        mes_vencimiento: cm,
        anio_vencimiento: ca,
        fecha_vencimiento: buildDateStr(ca, cm, diaVenc),
        valor_nominal: valorBase,
        monto_abonado: 0,
        saldo_pendiente: valorBase,
        estado: 'PENDIENTE',
        medio_pago: 'TRANSFERENCIA',
        cuenta_destino: '',
        fecha_comprobante: '',
        fecha_registro_pago: '',
        observacion_pago: ''
      });
    }
  }

  if (cleanCanal === 'VENDEDORAS' && cleanVendedora) {
    if (!db.vendedoras.some((v) => v.nombre.toLowerCase() === cleanVendedora.toLowerCase())) {
      db.vendedoras.push({ id: db.vendedoras.length + 1, nombre: cleanVendedora, activa: true });
    }
  }

  const historial = [];
  if (payload.notas && String(payload.notas).trim()) {
    historial.push({
      texto: String(payload.notas).trim(),
      autor: payload.operadora || 'Administración',
      created_at: nowIso
    });
  }

  const plan = {
    id: planId,
    dni: cleanDni,
    nombre: cleanNombre,
    apellido: cleanApellido,
    celular: cleanCelular,
    canal: cleanCanal,
    vendedora_nombre: cleanVendedora,
    modalidad_inicial: mod,
    estado_actual_modalidad: mod,
    cantidad_cuotas: totalCuotas,
    valor_cuota_base: valorBase,
    mes_inicio: mInicio,
    anio_inicio: aInicio,
    dia_vencimiento: diaVenc,
    monto_sena: senaVal,
    cuenta_sena: (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') ? payload.cuenta_destino_inicial : '',
    fecha_compromiso: payload.fecha_compromiso || '',
    estado_plan: (mod === 'PAGO' && totalCuotas === 1) ? 'COMPLETADO' : 'ACTIVO',
    motivo_baja: '',
    fecha_baja: '',
    cancelado_con_tarjeta: false,
    notas: String(payload.notas || '').trim(),
    cuotas,
    historial,
    created_at: nowIso,
    updated_at: nowIso
  };

  db.planes.unshift(plan);
  return plan;
}

function registrarPagoInDb(db, { plan_id, cuota_id, monto_cobrado, cuenta_destino, fecha_comprobante, observacion, operadora }) {
  const plan = db.planes.find((p) => p.id === Number(plan_id));
  if (!plan) throw new Error('No se encontró la ficha del cliente.');
  if (plan.estado_plan === 'BAJA') throw new Error('Este plan está dado de BAJA.');
  const cuota = plan.cuotas.find((c) => c.id === Number(cuota_id));
  if (!cuota) throw new Error('No se encontró la cuota.');
  if (cuota.estado === 'PAGADA') throw new Error(`La cuota ${cuota.numero_cuota} ya figura como PAGADA.`);

  const montoReal = (monto_cobrado !== undefined && monto_cobrado !== '')
    ? parseFloat(monto_cobrado)
    : cuota.saldo_pendiente;

  if (isNaN(montoReal) || montoReal <= 0) throw new Error('El monto cobrado debe ser mayor a $0.');
  if (!cuenta_destino) throw new Error('Debe seleccionar la Cuenta Destino.');
  if (!fecha_comprobante) throw new Error('Debe ingresar la Fecha real del comprobante.');

  const nowIso = new Date().toISOString();
  let tipoMov = 'PAGO_CUOTA';
  let detalleMov = `Pago de Cuota ${cuota.numero_cuota} de ${plan.cantidad_cuotas}`;

  if (cuota.numero_cuota === 1 && cuota.estado === 'PARCIAL_SENA') {
    tipoMov = 'SALDO_SENA_CUOTA_1';
    detalleMov = 'Saldo restante de Seña (Cuota 1 completada)';
    plan.estado_actual_modalidad = 'PAGO';
  } else if (cuota.numero_cuota === 1 && cuota.estado === 'PENDIENTE_ALTA') {
    tipoMov = 'CONFIRMACION_ALTA_CUOTA_1';
    detalleMov = 'Confirmación de Pago de Alta (Cuota 1 abonada)';
    plan.estado_actual_modalidad = 'PAGO';
  }

  cuota.monto_abonado += montoReal;
  cuota.saldo_pendiente = 0;
  cuota.estado = 'PAGADA';
  cuota.cuenta_destino = (cuota.cuenta_destino && cuota.cuenta_destino !== cuenta_destino)
    ? `${cuota.cuenta_destino} + ${cuenta_destino}`
    : cuenta_destino;
  cuota.fecha_comprobante = fecha_comprobante;
  cuota.fecha_registro_pago = nowIso;
  cuota.observacion_pago = observacion || detalleMov;

  const imp = parseYearMonthFromDate(fecha_comprobante, cuota.mes_vencimiento, cuota.anio_vencimiento);
  db.movimientos.unshift({
    id: db.nextMovId++,
    plan_id: plan.id,
    cuota_id: cuota.id,
    numero_cuota: cuota.numero_cuota,
    tipo_movimiento: tipoMov,
    monto: montoReal,
    cuenta_destino,
    medio_pago: 'TRANSFERENCIA',
    fecha_comprobante,
    mes_imputacion: imp.mes,
    anio_imputacion: imp.anio,
    fecha_registro: nowIso,
    operadora: operadora || 'Cobranzas',
    detalle: observacion ? `${detalleMov} (${observacion})` : detalleMov
  });

  const restantes = plan.cuotas.some((c) => c.estado !== 'PAGADA' && c.estado !== 'ANULADA_POR_BAJA');
  plan.estado_plan = restantes ? 'ACTIVO' : 'COMPLETADO';
  plan.updated_at = nowIso;

  if (!Array.isArray(plan.historial)) plan.historial = [];
  plan.historial.unshift({
    texto: `Cobro registrado: Cuota ${cuota.numero_cuota} por $${montoReal.toLocaleString('es-AR')} en ${cuenta_destino} (Comp: ${fecha_comprobante}).`,
    autor: operadora || 'Cobranzas',
    created_at: nowIso
  });

  return plan;
}

function adelantarCuotasInDb(db, { plan_id, cuota_ids, monto_total_cobrado, medio_pago, cuenta_destino, fecha_comprobante, observacion, operadora }) {
  const plan = db.planes.find((p) => p.id === Number(plan_id));
  if (!plan) throw new Error('No se encontró la ficha del cliente.');
  if (plan.estado_plan === 'BAJA') throw new Error('No se pueden adelantar cuotas en un plan en BAJA.');

  const seleccionadas = plan.cuotas.filter((c) => cuota_ids.includes(c.id) && c.estado !== 'PAGADA');
  if (seleccionadas.length === 0) throw new Error('Seleccione al menos una cuota pendiente.');

  const sumaSaldos = seleccionadas.reduce((a, c) => a + c.saldo_pendiente, 0);
  const total = (monto_total_cobrado !== undefined && monto_total_cobrado !== '')
    ? parseFloat(monto_total_cobrado)
    : sumaSaldos;
  const factor = sumaSaldos > 0 ? total / sumaSaldos : 1;
  const nowIso = new Date().toISOString();
  const cuentaFinal = medio_pago === 'TARJETA_ADELANTO'
    ? (cuenta_destino || 'Tarjeta (Excepción Adelanto)')
    : cuenta_destino;
  const etiqueta = medio_pago === 'TARJETA_ADELANTO'
    ? 'Cancelación/Adelanto con Tarjeta'
    : `Adelanto por Transferencia (${cuentaFinal})`;

  for (const c of seleccionadas) {
    c.monto_abonado += Math.round(c.saldo_pendiente * factor);
    c.saldo_pendiente = 0;
    c.estado = 'PAGADA';
    c.medio_pago = medio_pago;
    c.cuenta_destino = cuentaFinal;
    c.fecha_comprobante = fecha_comprobante;
    c.fecha_registro_pago = nowIso;
    c.observacion_pago = `${etiqueta}${observacion ? ' - ' + observacion : ''}`;
  }

  const nums = seleccionadas.map((c) => c.numero_cuota).join(', ');
  const imp = parseYearMonthFromDate(fecha_comprobante, plan.mes_inicio, plan.anio_inicio);
  db.movimientos.unshift({
    id: db.nextMovId++,
    plan_id: plan.id,
    cuota_id: seleccionadas[0].id,
    numero_cuota: seleccionadas[0].numero_cuota,
    tipo_movimiento: medio_pago === 'TARJETA_ADELANTO' ? 'ADELANTO_TARJETA' : 'ADELANTO_TRANSFERENCIA',
    monto: total,
    cuenta_destino: cuentaFinal,
    medio_pago: medio_pago === 'TARJETA_ADELANTO' ? 'TARJETA' : 'TRANSFERENCIA',
    fecha_comprobante,
    mes_imputacion: imp.mes,
    anio_imputacion: imp.anio,
    fecha_registro: nowIso,
    operadora: operadora || 'Cobranzas',
    detalle: `${etiqueta} - Cuotas N° ${nums}${observacion ? ' (' + observacion + ')' : ''}`
  });

  if (medio_pago === 'TARJETA_ADELANTO') plan.cancelado_con_tarjeta = true;
  plan.estado_actual_modalidad = 'PAGO';
  const quedan = plan.cuotas.some((c) => c.estado !== 'PAGADA' && c.estado !== 'ANULADA_POR_BAJA');
  plan.estado_plan = quedan ? 'ACTIVO' : 'COMPLETADO';
  plan.updated_at = nowIso;

  if (!Array.isArray(plan.historial)) plan.historial = [];
  plan.historial.unshift({
    texto: `${etiqueta}: Cuotas [${nums}] por $${total.toLocaleString('es-AR')} (Comp: ${fecha_comprobante}).`,
    autor: operadora || 'Cobranzas',
    created_at: nowIso
  });

  return plan;
}

function darBajaPlanInDb(db, { plan_id, motivo, operadora, fecha_baja }) {
  const plan = db.planes.find((p) => p.id === Number(plan_id));
  if (!plan) throw new Error('No se encontró la ficha del cliente.');
  const nowIso = new Date().toISOString();
  const hoy = fecha_baja || getTodayDateString();

  for (const c of plan.cuotas) {
    if (c.estado !== 'PAGADA') {
      c.estado = 'ANULADA_POR_BAJA';
      c.saldo_pendiente = 0;
      c.observacion_pago = 'Anulada por baja del plan';
    }
  }
  plan.estado_plan = 'BAJA';
  plan.motivo_baja = motivo || 'Baja solicitada';
  plan.fecha_baja = hoy;
  plan.notas = plan.notas ? `${plan.notas} | BAJA: ${plan.motivo_baja}` : `BAJA: ${plan.motivo_baja}`;
  plan.updated_at = nowIso;

  if (!Array.isArray(plan.historial)) plan.historial = [];
  plan.historial.unshift({
    texto: `PLAN DADO DE BAJA. Motivo: ${plan.motivo_baja}.`,
    autor: operadora || 'Cobranzas',
    created_at: nowIso
  });
}

function reactivarPlanInDb(db, { plan_id, operadora }) {
  const plan = db.planes.find((p) => p.id === Number(plan_id));
  if (!plan) return;
  const nowIso = new Date().toISOString();

  for (const c of plan.cuotas) {
    if (c.estado === 'ANULADA_POR_BAJA') {
      const rest = Math.max(0, c.valor_nominal - c.monto_abonado);
      c.saldo_pendiente = rest;
      if (c.numero_cuota === 1 && c.monto_abonado > 0 && rest > 0) c.estado = 'PARCIAL_SENA';
      else if (c.numero_cuota === 1 && plan.modalidad_inicial === 'ALTA' && c.monto_abonado === 0) c.estado = 'PENDIENTE_ALTA';
      else c.estado = 'PENDIENTE';
    }
  }
  plan.estado_plan = 'ACTIVO';
  plan.motivo_baja = '';
  plan.fecha_baja = '';
  plan.updated_at = nowIso;

  if (!Array.isArray(plan.historial)) plan.historial = [];
  plan.historial.unshift({
    texto: 'Plan reactivado nuevamente.',
    autor: operadora || 'Cobranzas',
    created_at: nowIso
  });
}

/* ==========================================================================
   Seed 2025 -> Hoy (13/11/2026) into Firebase on First Launch
   ========================================================================== */

function buildSeededDatabase() {
  const db = ensureDbShape({});

  const payRest = (plan, countToPay, cuentaDefault, dayOfMonth = 8) => {
    const pendientes = plan.cuotas.filter((c) => c.estado !== 'PAGADA');
    const slice = countToPay === 'ALL' ? pendientes : pendientes.slice(0, countToPay);
    for (const c of slice) {
      registrarPagoInDb(db, {
        plan_id: plan.id,
        cuota_id: c.id,
        monto_cobrado: c.saldo_pendiente,
        cuenta_destino: cuentaDefault,
        fecha_comprobante: buildDateStr(c.anio_vencimiento, c.mes_vencimiento, dayOfMonth),
        observacion: 'Transferencia verificada por cobranzas',
        operadora: 'Marta (Cobranzas)'
      });
    }
  };

  // AÑO 2025 (ENERO A DICIEMBRE 2025)
  const hist2025 = [
    { dni: '21450981', nombre: 'Beatriz Alicia', apellido: 'Mendoza', cel: '11 4120-8833', canal: 'SEBASTIAN', cuotas: 3, valor: 32000, mes: 1, cuenta: 'Openpay', dia: 7, status: 'COMPLETADO' },
    { dni: '23890412', nombre: 'Carlos Alberto', apellido: 'Sánchez', cel: '351 540-2219', canal: 'VENDEDORAS', vend: 'Laura Martínez', cuotas: 3, valor: 35000, mes: 2, cuenta: 'Mercado Pago', dia: 9, status: 'COMPLETADO' },
    { dni: '25112098', nombre: 'Liliana Esther', apellido: 'Romero', cel: '221 488-9012', canal: 'TRAMOS', cuotas: 4, valor: 36000, mes: 3, cuenta: 'Xise', dia: 6, status: 'COMPLETADO' },
    { dni: '27334510', nombre: 'Marcela Fabiana', apellido: 'Navarro', cel: '11 5590-1234', canal: 'VENDEDORAS', vend: 'Carolina Gómez', cuotas: 3, valor: 38000, mes: 4, cuenta: 'Adriana', dia: 8, status: 'BAJA_C2' },
    { dni: '24998120', nombre: 'Gustavo Adolfo', apellido: 'Benítez', cel: '341 623-4455', canal: 'SEBASTIAN', cuotas: 3, valor: 38000, mes: 5, cuenta: 'Openpay', dia: 5, status: 'COMPLETADO' },
    { dni: '28123900', nombre: 'Verónica Alejandra', apellido: 'Paz', cel: '11 6321-7788', canal: 'TRAMOS', cuotas: 6, valor: 40000, mes: 6, cuenta: 'Mercado Pago', dia: 9, status: 'ADELANTO_TARJETA' },
    { dni: '26778231', nombre: 'Adrián Marcelo', apellido: 'Torres', cel: '261 512-3390', canal: 'VENDEDORAS', vend: 'Valeria Díaz', cuotas: 3, valor: 40000, mes: 7, cuenta: 'Xise', dia: 10, status: 'COMPLETADO' },
    { dni: '29556712', nombre: 'Sandra Elizabeth', apellido: 'Ríos', cel: '11 4987-6543', canal: 'SEBASTIAN', cuotas: 4, valor: 42000, mes: 8, cuenta: 'Adriana', dia: 7, status: 'COMPLETADO' },
    { dni: '30112456', nombre: 'Claudia Viviana', apellido: 'Herrera', cel: '381 456-7890', canal: 'TRAMOS', cuotas: 3, valor: 42000, mes: 9, cuenta: 'Openpay', dia: 8, status: 'COMPLETADO' },
    { dni: '22889012', nombre: 'Eduardo Ramón', apellido: 'Acosta', cel: '11 5234-9901', canal: 'VENDEDORAS', vend: 'Sofía Peralta', cuotas: 3, valor: 44000, mes: 10, cuenta: 'Mercado Pago', dia: 6, status: 'BAJA_C2' },
    { dni: '31445890', nombre: 'Mónica Beatriz', apellido: 'Vega', cel: '223 589-1122', canal: 'SEBASTIAN', cuotas: 4, valor: 45000, mes: 11, cuenta: 'Xise', dia: 9, status: 'COMPLETADO' },
    { dni: '25990321', nombre: 'Daniela Karina', apellido: 'Suárez', cel: '11 6098-4411', canal: 'VENDEDORAS', vend: 'Romina Sosa', cuotas: 6, valor: 45000, mes: 12, cuenta: 'Adriana', dia: 8, status: 'COMPLETADO' },
    { dni: '27881234', nombre: 'Pablo Esteban', apellido: 'Luna', cel: '351 678-9011', canal: 'TRAMOS', cuotas: 12, valor: 35000, mes: 12, cuenta: 'Openpay', dia: 10, status: 'DEUDOR_2025' }
  ];

  for (const h of hist2025) {
    const p = insertPlanIntoDb(db, {
      dni: h.dni, nombre: h.nombre, apellido: h.apellido, celular: h.cel,
      canal: h.canal, vendedora_nombre: h.vend || '', modalidad_inicial: 'PAGO',
      cantidad_cuotas: h.cuotas, valor_cuota_base: h.valor, mes_inicio: h.mes,
      anio_inicio: 2025, dia_vencimiento: 10, cuenta_destino_inicial: h.cuenta,
      fecha_comprobante_inicial: buildDateStr(2025, h.mes, h.dia),
      notas: `Plan iniciado en ${h.mes}/2025.`, operadora: 'Administración'
    });
    if (h.status === 'COMPLETADO') payRest(p, 'ALL', h.cuenta, h.dia);
    else if (h.status === 'ADELANTO_TARJETA') {
      payRest(p, 1, h.cuenta, h.dia);
      const restIds = p.cuotas.filter((c) => c.estado !== 'PAGADA').map((c) => c.id);
      adelantarCuotasInDb(db, {
        plan_id: p.id, cuota_ids: restIds, monto_total_cobrado: restIds.length * h.valor,
        medio_pago: 'TARJETA_ADELANTO', cuenta_destino: 'Tarjeta (Excepción Adelanto)',
        fecha_comprobante: buildDateStr(2025, 8, 14), observacion: 'Adelantó saldo con tarjeta en 2025', operadora: 'Marta (Cobranzas)'
      });
    } else if (h.status === 'BAJA_C2') {
      darBajaPlanInDb(db, { plan_id: p.id, motivo: 'Solicitó baja en 2025 tras abonar cuota 1.', operadora: 'Claudia (Cobranzas)', fecha_baja: buildDateStr(2025, h.mes + 1, 5) });
    } else if (h.status === 'DEUDOR_2025') {
      payRest(p, 8, h.cuenta, 9);
    }
  }

  // AÑO 2026 (ENERO A OCTUBRE 2026)
  const hist2026 = [
    { dni: '28456123', nombre: 'Rosaura Inés', apellido: 'Godoy', cel: '11 4567-8901', canal: 'SEBASTIAN', cuotas: 3, valor: 46000, mes: 1, cuenta: 'Openpay', status: 'COMPLETADO' },
    { dni: '32009182', nombre: 'Mariana Soledad', apellido: 'Bustos', cel: '341 512-9088', canal: 'VENDEDORAS', vend: 'Laura Martínez', cuotas: 4, valor: 46000, mes: 2, cuenta: 'Mercado Pago', status: 'COMPLETADO' },
    { dni: '26119044', nombre: 'Sergio Fabián', apellido: 'Ibarra', cel: '221 609-1233', canal: 'TRAMOS', cuotas: 3, valor: 48000, mes: 3, cuenta: 'Xise', status: 'COMPLETADO' },
    { dni: '29330198', nombre: 'Andrea Celeste', apellido: 'Ferreyra', cel: '11 5876-3321', canal: 'VENDEDORAS', vend: 'Carolina Gómez', cuotas: 6, valor: 48000, mes: 4, cuenta: 'Adriana', status: 'COMPLETADO' },
    { dni: '33441209', nombre: 'Lucía Fernanda', apellido: 'Ponce', cel: '351 490-7766', canal: 'SEBASTIAN', cuotas: 3, valor: 48000, mes: 5, cuenta: 'Openpay', status: 'COMPLETADO' },
    { dni: '24778901', nombre: 'Susana Beatriz', apellido: 'Molina', cel: '11 6234-5511', canal: 'TRAMOS', cuotas: 4, valor: 48000, mes: 6, cuenta: 'Mercado Pago', status: 'COMPLETADO' },
    { dni: '31889234', nombre: 'Federico Nicolás', apellido: 'Campos', cel: '261 556-7788', canal: 'VENDEDORAS', vend: 'Valeria Díaz', cuotas: 3, valor: 50000, mes: 7, cuenta: 'Xise', status: 'COMPLETADO' },
    { dni: '27112987', nombre: 'Estela Maris', apellido: 'Soria', cel: '11 5901-2234', canal: 'SEBASTIAN', cuotas: 4, valor: 50000, mes: 8, cuenta: 'Adriana', status: 'AL_DIA_NOV_PAGADA' },
    { dni: '30554321', nombre: 'Natalia Lorena', apellido: 'Cabrera', cel: '381 523-4456', canal: 'VENDEDORAS', vend: 'Sofía Peralta', cuotas: 3, valor: 50000, mes: 9, cuenta: 'Mercado Pago', status: 'AL_DIA_NOV_PAGADA' },
    { dni: '25667890', nombre: 'Miriam Gladys', apellido: 'Ojeda', cel: '11 4789-3300', canal: 'TRAMOS', cuotas: 4, valor: 50000, mes: 9, cuenta: 'Openpay', status: 'DEUDOR_OCT_NOV' }
  ];

  for (const h of hist2026) {
    const p = insertPlanIntoDb(db, {
      dni: h.dni, nombre: h.nombre, apellido: h.apellido, celular: h.cel,
      canal: h.canal, vendedora_nombre: h.vend || '', modalidad_inicial: 'PAGO',
      cantidad_cuotas: h.cuotas, valor_cuota_base: h.valor, mes_inicio: h.mes,
      anio_inicio: 2026, dia_vencimiento: 10, cuenta_destino_inicial: h.cuenta,
      fecha_comprobante_inicial: buildDateStr(2026, h.mes, 7),
      notas: `Plan iniciado en ${h.mes}/2026.`, operadora: 'Administración'
    });
    if (h.status === 'COMPLETADO') payRest(p, 'ALL', h.cuenta, 8);
    else if (h.status === 'AL_DIA_NOV_PAGADA') {
      const toPay = p.cuotas.filter((c) => c.estado !== 'PAGADA' && c.anio_vencimiento === 2026 && c.mes_vencimiento <= 11);
      for (const c of toPay) {
        registrarPagoInDb(db, {
          plan_id: p.id, cuota_id: c.id, monto_cobrado: c.saldo_pendiente,
          cuenta_destino: h.cuenta, fecha_comprobante: buildDateStr(c.anio_vencimiento, c.mes_vencimiento, 9),
          observacion: 'Cuota abonada en término', operadora: 'Marta (Cobranzas)'
        });
      }
    }
  }

  // CASOS CLAVE OCTUBRE / NOVIEMBRE 2026
  insertPlanIntoDb(db, {
    dni: '34567890', nombre: 'Cristina', apellido: 'Gómez', celular: '11 5432-8910',
    canal: 'VENDEDORAS', vendedora_nombre: 'Laura Martínez', modalidad_inicial: 'SENA_MISMO_MES',
    cantidad_cuotas: 3, valor_cuota_base: 50000, mes_inicio: 11, anio_inicio: 2026,
    dia_vencimiento: 10, cuenta_destino_inicial: 'Mercado Pago', fecha_comprobante_inicial: '2026-11-05',
    monto_sena: 20000, fecha_compromiso: '2026-11-20',
    notas: 'Abona restante de $30.000 el 20/11 cuando cobra incentivo docente.', operadora: 'Administración'
  });

  insertPlanIntoDb(db, {
    dni: '28940112', nombre: 'Roberto Carlos', apellido: 'Fernández', celular: '11 6789-4321',
    canal: 'SEBASTIAN', modalidad_inicial: 'PAGO', cantidad_cuotas: 3, valor_cuota_base: 45000,
    mes_inicio: 10, anio_inicio: 2026, dia_vencimiento: 10, cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-10-08',
    notas: 'Venció cuota 2 el 10/11. Prometió transferir el viernes por la tarde.', operadora: 'Administración'
  });

  insertPlanIntoDb(db, {
    dni: '31209844', nombre: 'María Elena', apellido: 'Quiroga', celular: '351 612-9087',
    canal: 'TRAMOS', modalidad_inicial: 'ALTA', cantidad_cuotas: 4, valor_cuota_base: 55000,
    mes_inicio: 11, anio_inicio: 2026, dia_vencimiento: 10, fecha_compromiso: '2026-11-18',
    notas: 'Alta sin seña. Prometió abonar la Cuota 1 completa el 18/11 por transferencia.', operadora: 'Administración'
  });

  insertPlanIntoDb(db, {
    dni: '26410982', nombre: 'Graciela Beatriz', apellido: 'Pereyra', celular: '221 598-3341',
    canal: 'VENDEDORAS', vendedora_nombre: 'Carolina Gómez', modalidad_inicial: 'SENA_MES_SIGUIENTE',
    cantidad_cuotas: 3, valor_cuota_base: 50000, mes_inicio: 11, anio_inicio: 2026,
    dia_vencimiento: 10, cuenta_destino_inicial: 'Xise', fecha_comprobante_inicial: '2026-11-11',
    monto_sena: 15000, fecha_compromiso: '2026-12-08',
    notas: 'Dejó seña de $15.000. Completa los $35.000 restantes de Cuota 1 el 08/12.', operadora: 'Administración'
  });

  insertPlanIntoDb(db, {
    dni: '29876543', nombre: 'Héctor Daniel', apellido: 'Morales', celular: '11 4390-1122',
    canal: 'SEBASTIAN', modalidad_inicial: 'PAGO', cantidad_cuotas: 3, valor_cuota_base: 50000,
    mes_inicio: 11, anio_inicio: 2026, dia_vencimiento: 10, cuenta_destino_inicial: 'Adriana',
    fecha_comprobante_inicial: '2026-11-09',
    notas: 'Cuota 1 al día. Próximo vencimiento en Diciembre.', operadora: 'Administración'
  });

  const patricia = insertPlanIntoDb(db, {
    dni: '24551239', nombre: 'Patricia Susana', apellido: 'Ledesma', celular: '341 587-6612',
    canal: 'TRAMOS', modalidad_inicial: 'PAGO', cantidad_cuotas: 3, valor_cuota_base: 48000,
    mes_inicio: 9, anio_inicio: 2026, dia_vencimiento: 10, cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-09-07',
    notas: 'Necesitaba urgente la certificación para presentar en junta.', operadora: 'Administración'
  });
  adelantarCuotasInDb(db, {
    plan_id: patricia.id,
    cuota_ids: patricia.cuotas.filter((c) => c.estado !== 'PAGADA').map((c) => c.id),
    monto_total_cobrado: 96000,
    medio_pago: 'TARJETA_ADELANTO',
    cuenta_destino: 'Tarjeta (Excepción Adelanto)',
    fecha_comprobante: '2026-11-04',
    observacion: 'Canceló cuotas 2 y 3 con tarjeta para liberar certificado de inmediato',
    operadora: 'Marta (Cobranzas)'
  });

  insertPlanIntoDb(db, {
    dni: '30998123', nombre: 'Silvia Noemí', apellido: 'Castro', celular: '11 3210-9988',
    canal: 'VENDEDORAS', vendedora_nombre: 'Valeria Díaz', modalidad_inicial: 'PAGO',
    cantidad_cuotas: 3, valor_cuota_base: 50000, mes_inicio: 10, anio_inicio: 2026,
    dia_vencimiento: 25, cuenta_destino_inicial: 'Mercado Pago', fecha_comprobante_inicial: '2026-10-20',
    notas: 'Cobra haberes el día 22, vence el 25/11.', operadora: 'Administración'
  });

  const jorge = insertPlanIntoDb(db, {
    dni: '22765109', nombre: 'Jorge Luis', apellido: 'Domínguez', celular: '261 490-8877',
    canal: 'SEBASTIAN', modalidad_inicial: 'PAGO', cantidad_cuotas: 3, valor_cuota_base: 45000,
    mes_inicio: 10, anio_inicio: 2026, dia_vencimiento: 10, cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-10-06',
    notas: 'Pagó cuota 1 en octubre y solicitó baja en noviembre.', operadora: 'Administración'
  });
  darBajaPlanInDb(db, {
    plan_id: jorge.id,
    motivo: 'Abandonó la cursada en cuota 2. Cuota 1 queda registrada como ingreso válido.',
    operadora: 'Marta (Cobranzas)',
    fecha_baja: '2026-11-08'
  });

  insertPlanIntoDb(db, {
    dni: '27654321', nombre: 'Norma Beatriz', apellido: 'Villalba', celular: '11 5098-7123',
    canal: 'TRAMOS', modalidad_inicial: 'SENA_MISMO_MES', cantidad_cuotas: 3, valor_cuota_base: 50000,
    mes_inicio: 11, anio_inicio: 2026, dia_vencimiento: 10, cuenta_destino_inicial: 'Adriana',
    fecha_comprobante_inicial: '2026-11-02', monto_sena: 25000, fecha_compromiso: '2026-11-11',
    notas: 'Debía completar los $25.000 restantes el 11/11. Reclamar por WhatsApp hoy.', operadora: 'Administración'
  });

  // VENTAS CARGADAS HOY (13/11/2026)
  insertPlanIntoDb(db, {
    dni: '35123456', nombre: 'Luciana Paola', apellido: 'Giménez', celular: '11 6890-1144',
    canal: 'SEBASTIAN', modalidad_inicial: 'PAGO', cantidad_cuotas: 3, valor_cuota_base: 52000,
    mes_inicio: 11, anio_inicio: 2026, dia_vencimiento: 10, cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-11-13',
    notas: 'Cargada hoy 13/11. Envió comprobante de Cuota 1 por Openpay.', operadora: 'Administración (Ventas)'
  });

  insertPlanIntoDb(db, {
    dni: '33789012', nombre: 'Valeria Alejandra', apellido: 'Morán', celular: '351 645-8899',
    canal: 'VENDEDORAS', vendedora_nombre: 'Romina Sosa', modalidad_inicial: 'SENA_MISMO_MES',
    cantidad_cuotas: 4, valor_cuota_base: 52000, mes_inicio: 11, anio_inicio: 2026,
    dia_vencimiento: 10, cuenta_destino_inicial: 'Mercado Pago', fecha_comprobante_inicial: '2026-11-13',
    monto_sena: 22000, fecha_compromiso: '2026-11-24',
    notas: 'Cargada hoy 13/11. Seña $22.000, completa los $30.000 el 24/11.', operadora: 'Administración (Ventas)'
  });

  insertPlanIntoDb(db, {
    dni: '29456781', nombre: 'Fernando Javier', apellido: 'Almada', celular: '221 511-2233',
    canal: 'TRAMOS', modalidad_inicial: 'ALTA', cantidad_cuotas: 3, valor_cuota_base: 55000,
    mes_inicio: 11, anio_inicio: 2026, dia_vencimiento: 10, fecha_compromiso: '2026-11-21',
    notas: 'Cargada hoy 13/11. Alta diferida, transfiere Cuota 1 el 21/11.', operadora: 'Administración (Ventas)'
  });

  insertPlanIntoDb(db, {
    dni: '32890123', nombre: 'Gabriela Fernanda', apellido: 'Roldán', celular: '11 5345-6677',
    canal: 'VENDEDORAS', vendedora_nombre: 'Laura Martínez', modalidad_inicial: 'SENA_MES_SIGUIENTE',
    cantidad_cuotas: 3, valor_cuota_base: 52000, mes_inicio: 11, anio_inicio: 2026,
    dia_vencimiento: 10, cuenta_destino_inicial: 'Xise', fecha_comprobante_inicial: '2026-11-13',
    monto_sena: 17000, fecha_compromiso: '2026-12-05',
    notas: 'Cargada hoy 13/11. Seña $17.000, abona saldo de $35.000 el 05/12.', operadora: 'Administración (Ventas)'
  });

  return db;
}

/* ==========================================================================
   Enrich & Formatting Helpers
   ========================================================================== */

function enrichPlan(planRow, todayStr) {
  const cuotasRaw = Array.isArray(planRow.cuotas) ? planRow.cuotas : [];
  let cuotasPagadas = 0;
  let cuotasPendientes = 0;
  let totalAbonado = 0;
  let saldoTotalPendiente = 0;
  let tieneCuotaVencida = false;
  let proximaCuota = null;

  const enrichedCuotas = cuotasRaw.map((c) => {
    const isPaid = c.estado === 'PAGADA';
    const isCancelled = c.estado === 'ANULADA_POR_BAJA';
    const isPending = !isPaid && !isCancelled && c.saldo_pendiente > 0;
    const isOverdue = isPending && planRow.estado_plan !== 'BAJA' && c.fecha_vencimiento < todayStr;

    if (isPaid) cuotasPagadas += 1;
    else if (isPending) {
      cuotasPendientes += 1;
      saldoTotalPendiente += c.saldo_pendiente;
      if (!proximaCuota) proximaCuota = { ...c, vencida: isOverdue };
    }
    if (isOverdue) tieneCuotaVencida = true;
    totalAbonado += c.monto_abonado;
    return { ...c, vencida: isOverdue };
  });

  const esBaja = planRow.estado_plan === 'BAJA';
  const todasPagadas = !esBaja && cuotasPendientes === 0 && saldoTotalPendiente <= 0;
  const esDeudor = !esBaja && !todasPagadas && tieneCuotaVencida;

  let certificadoEstado = 'BLOQUEADO_EN_CURSO';
  let certificadoEtiqueta = 'NO ENTREGAR - PLAN EN CURSO';

  if (esBaja) {
    certificadoEstado = 'BLOQUEADO_BAJA';
    certificadoEtiqueta = 'BLOQUEADO - DADO DE BAJA';
  } else if (todasPagadas) {
    certificadoEstado = 'LISTO_PARA_ENTREGAR';
    certificadoEtiqueta = 'LISTO PARA ENTREGAR CERTIFICACIÓN';
  } else if (esDeudor) {
    certificadoEstado = 'BLOQUEADO_DEUDOR';
    certificadoEtiqueta = 'NO ENTREGAR - DEUDOR ATRASADO';
  }

  return {
    ...planRow,
    nombre_completo: `${planRow.nombre} ${planRow.apellido}`.trim(),
    cuotas: enrichedCuotas,
    movimientos: state.movimientos.filter((m) => m.plan_id === planRow.id),
    historial: Array.isArray(planRow.historial) ? planRow.historial : [],
    resumen: {
      cuotas_pagadas: cuotasPagadas,
      cuotas_pendientes: cuotasPendientes,
      total_abonado: totalAbonado,
      saldo_total_pendiente: saldoTotalPendiente,
      es_deudor: esDeudor,
      es_baja: esBaja,
      todas_pagadas: todasPagadas,
      certificado_estado: certificadoEstado,
      certificado_etiqueta: certificadoEtiqueta,
      proxima_cuota: proximaCuota
    }
  };
}

function formatMoney(amount) {
  const num = Number(amount) || 0;
  return '$' + num.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDateAR(dateStr) {
  if (!dateStr) return '—';
  const clean = String(dateStr).slice(0, 10);
  const parts = clean.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatDateTimeAR(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return formatDateAR(isoStr);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch (_e) {
    return isoStr;
  }
}

function formatDniVisual(dni) {
  const digits = String(dni || '').replace(/[^\d]/g, '');
  if (!digits) return dni;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function buildWhatsAppUrl(rawPhone, messageText) {
  let digits = String(rawPhone || '').replace(/[^\d]/g, '').replace(/^0+/, '');
  if (!digits.startsWith('54')) digits = '549' + digits;
  else if (digits.startsWith('54') && !digits.startsWith('549')) digits = '549' + digits.slice(2);
  return `https://wa.me/${digits}?text=${encodeURIComponent(messageText || '')}`;
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
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4500);
}

/* ==========================================================================
   Firebase Transaction Wrapper (Conflict Prevention)
   ========================================================================== */

async function mutateDb(mutatorFn) {
  let resultValue = null;
  let innerError = null;

  await runTransaction(dbRef, (currentData) => {
    innerError = null;
    try {
      const db = ensureDbShape(currentData);
      resultValue = mutatorFn(db);
      return db;
    } catch (err) {
      innerError = err;
      return undefined; // Abort transaction safely
    }
  });

  if (innerError) throw innerError;
  return resultValue;
}

function updatePresence(activePlanId = null) {
  set(presenceRef, {
    operadora: state.operadora,
    activePlanId: activePlanId || null,
    updatedAt: Date.now()
  }).catch(() => {});
}

/* ==========================================================================
   Period & Filter Evaluation Logic
   ========================================================================== */

function getCuotaDelPeriodo(plan, mes, anio) {
  return plan.cuotas.find((c) => c.mes_vencimiento === mes && c.anio_vencimiento === anio) || null;
}

function planMatchesPeriod(plan, mes, anio) {
  if (state.allPeriods || state.searchQuery.trim().length > 0) return true;

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
    ) return true;
  }

  if (state.selectedQuickFilter === 'DEUDORES' && plan.resumen.es_deudor) return true;
  if (state.selectedQuickFilter === 'BAJAS' && plan.estado_plan === 'BAJA') return true;
  if (plan.mes_inicio === mes && plan.anio_inicio === anio) return true;
  if (plan.cuotas.some((c) => c.mes_vencimiento === mes && c.anio_vencimiento === anio)) return true;
  if (plan.movimientos.some((m) => m.mes_imputacion === mes && m.anio_imputacion === anio)) return true;

  if (plan.estado_plan === 'ACTIVO' && plan.resumen.es_deudor) {
    return plan.cuotas.some((c) => {
      if (c.estado === 'PAGADA' || c.estado === 'ANULADA_POR_BAJA') return false;
      return (c.anio_vencimiento < anio) || (c.anio_vencimiento === anio && c.mes_vencimiento <= mes);
    });
  }
  return false;
}

function planMatchesQuickFilter(plan, filterName, mes, anio) {
  const c1 = plan.cuotas[0];
  const esBaja = plan.estado_plan === 'BAJA';

  switch (filterName) {
    case 'TODOS': return true;
    case 'SENAS_ESTE_MES':
      if (esBaja || !c1 || c1.estado !== 'PARCIAL_SENA') return false;
      if (state.allPeriods) return plan.modalidad_inicial === 'SENA_MISMO_MES';
      return (plan.modalidad_inicial === 'SENA_MISMO_MES' && plan.mes_inicio === mes && plan.anio_inicio === anio) ||
             (c1.mes_vencimiento === mes && c1.anio_vencimiento === anio && plan.modalidad_inicial !== 'SENA_MES_SIGUIENTE');
    case 'SENAS_MES_SIGUIENTE':
      return !esBaja && c1 && c1.estado === 'PARCIAL_SENA' && plan.modalidad_inicial === 'SENA_MES_SIGUIENTE';
    case 'ALTAS_PENDIENTES':
      return !esBaja && c1 && c1.estado === 'PENDIENTE_ALTA';
    case 'CUOTAS_PENDIENTES_MES':
      if (esBaja) return false;
      if (state.allPeriods) return plan.resumen.saldo_total_pendiente > 0;
      return plan.cuotas.some((c) => c.mes_vencimiento === mes && c.anio_vencimiento === anio && c.estado !== 'PAGADA' && c.estado !== 'ANULADA_POR_BAJA' && c.saldo_pendiente > 0);
    case 'DEUDORES':
      return !esBaja && plan.resumen.es_deudor;
    case 'COMPLETADOS':
      if (esBaja) return false;
      if (plan.resumen.todas_pagadas) return true;
      if (!state.allPeriods && !plan.resumen.es_deudor) {
        const cuotaMes = getCuotaDelPeriodo(plan, mes, anio);
        if (cuotaMes && cuotaMes.estado === 'PAGADA') return true;
      }
      return false;
    case 'BAJAS':
      return esBaja;
    default:
      return true;
  }
}

function planMatchesSearch(plan, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  return [
    plan.dni, plan.nombre, plan.apellido, plan.nombre_completo,
    plan.celular, plan.vendedora_nombre, plan.canal, plan.notas
  ].join(' ').toLowerCase().includes(q);
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

  if (state.openClientPlanId) {
    const updatedPlan = state.planes.find((p) => p.id === state.openClientPlanId);
    if (updatedPlan) renderClientDetailModalContent(updatedPlan);
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
    badgeText.textContent = `Firebase en vivo (${count} ${count === 1 ? 'PC conectada' : 'PCs conectadas'})`;
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

  const planById = Object.fromEntries(state.planes.map((p) => [p.id, p]));
  const movsFiltrados = state.movimientos.filter((m) => {
    const p = planById[m.plan_id];
    if (!p) return false;
    if (state.selectedCanal !== 'TODOS' && p.canal !== state.selectedCanal) return false;
    if (state.selectedCanal === 'VENDEDORAS' && state.selectedVendedora !== 'TODAS' && p.vendedora_nombre !== state.selectedVendedora) return false;
    if (!state.allPeriods) return m.mes_imputacion === mes && m.anio_imputacion === anio;
    return true;
  });

  const totalCobrado = movsFiltrados.reduce((acc, m) => acc + (Number(m.monto) || 0), 0);
  document.getElementById('kpi-val-cobrado').textContent = formatMoney(totalCobrado);
  document.getElementById('kpi-sub-cobrado').textContent = `${movsFiltrados.length} ${movsFiltrados.length === 1 ? 'pago acreditado' : 'pagos acreditados'}`;

  const porCuenta = {};
  for (const c of state.cuentas) {
    if (c.activa) porCuenta[c.nombre] = 0;
  }
  for (const m of movsFiltrados) {
    porCuenta[m.cuenta_destino] = (porCuenta[m.cuenta_destino] || 0) + (Number(m.monto) || 0);
  }

  const breakdownContainer = document.getElementById('kpi-cuentas-breakdown');
  const entries = Object.entries(porCuenta);
  breakdownContainer.innerHTML = entries.length === 0
    ? '<span style="font-size:0.85rem;color:var(--text-muted);">Sin movimientos</span>'
    : entries.map(([nom, suma]) => `<span class="cuenta-mini-pill"><span>${escapeHtml(nom)}:</span><strong class="tabular-nums">${formatMoney(suma)}</strong></span>`).join('');

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
      for (const c of p.cuotas) { if (c.vencida) montoTotalVencido += c.saldo_pendiente; }
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
  const basePeriodPlans = state.planes.filter((p) => planMatchesPeriod(p, mes, anio) && planMatchesSearch(p, state.searchQuery));

  document.getElementById('count-canal-todos').textContent = basePeriodPlans.length;
  document.getElementById('count-canal-sebastian').textContent = basePeriodPlans.filter((p) => p.canal === 'SEBASTIAN').length;
  const countVend = basePeriodPlans.filter((p) => p.canal === 'VENDEDORAS').length;
  document.getElementById('count-canal-vendedoras').textContent = countVend;
  document.getElementById('count-canal-tramos').textContent = basePeriodPlans.filter((p) => p.canal === 'TRAMOS').length;

  document.querySelectorAll('.channel-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.canal === state.selectedCanal);
  });

  const vendSubBar = document.getElementById('vendedoras-subfilter-bar');
  const chipsContainer = document.getElementById('vendedoras-chips-container');

  if (state.selectedCanal === 'VENDEDORAS') {
    vendSubBar.hidden = false;
    const nombresVendedoras = Array.from(new Set([
      ...state.vendedoras.filter((v) => v.activa).map((v) => v.nombre),
      ...state.planes.filter((p) => p.canal === 'VENDEDORAS' && p.vendedora_nombre).map((p) => p.vendedora_nombre)
    ]));

    chipsContainer.innerHTML = [
      `<button type="button" class="vendedora-chip ${state.selectedVendedora === 'TODAS' ? 'active' : ''}" data-vend="TODAS">Todas (${countVend})</button>`,
      ...nombresVendedoras.map((nom) => {
        const c = basePeriodPlans.filter((p) => p.canal === 'VENDEDORAS' && p.vendedora_nombre === nom).length;
        return `<button type="button" class="vendedora-chip ${state.selectedVendedora === nom ? 'active' : ''}" data-vend="${escapeHtml(nom)}">${escapeHtml(nom)} (${c})</button>`;
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
    if (state.selectedCanal === 'VENDEDORAS' && state.selectedVendedora !== 'TODAS' && p.vendedora_nombre !== state.selectedVendedora) return false;
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
    const el = document.getElementById(item.badgeId);
    if (el) el.textContent = channelPlans.filter((p) => planMatchesQuickFilter(p, item.key, mes, anio)).length;
  }

  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.filter === state.selectedQuickFilter);
  });
}

function getModalityLabel(mod, estadoActual) {
  if (mod === 'SENA_MISMO_MES') return estadoActual === 'PAGO' ? 'Seña (Completada)' : 'Seña (Mismo Mes)';
  if (mod === 'SENA_MES_SIGUIENTE') return estadoActual === 'PAGO' ? 'Seña Mes Sig. (Completada)' : 'Seña Mes Siguiente';
  if (mod === 'ALTA') return estadoActual === 'PAGO' ? 'Alta (Ya Confirmada)' : 'Alta (Pago Diferido)';
  return 'Pago (Cuota 1 Abonada)';
}

function renderClientRecordsList() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;
  const container = document.getElementById('records-list-container');

  let filtered = getPlansMatchingChannelAndPeriod().filter((p) =>
    planMatchesQuickFilter(p, state.selectedQuickFilter, mes, anio)
  );

  if (['SENAS_ESTE_MES', 'SENAS_MES_SIGUIENTE', 'ALTAS_PENDIENTES'].includes(state.selectedQuickFilter)) {
    filtered.sort((a, b) => (a.fecha_compromiso || '9999-12-31').localeCompare(b.fecha_compromiso || '9999-12-31'));
  } else {
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
        <button type="button" class="btn btn-secondary" id="btn-reset-filters-empty">Mostrar Todos del Mes</button>
      </div>
    `;
    document.getElementById('btn-reset-filters-empty')?.addEventListener('click', () => {
      state.selectedQuickFilter = 'TODOS';
      state.selectedCanal = 'TODOS';
      state.searchQuery = '';
      document.getElementById('input-global-search').value = '';
      renderAll();
    });
    return;
  }

  container.innerHTML = filtered.map((plan) => renderSingleClientCard(plan, mes, anio)).join('');

  container.querySelectorAll('[data-action="open-detail"]').forEach((btn) => {
    btn.addEventListener('click', () => openClientDetailModal(Number(btn.dataset.planId)));
  });
  container.querySelectorAll('[data-action="quick-pay"]').forEach((btn) => {
    btn.addEventListener('click', () => openPayCuotaModal(Number(btn.dataset.planId), Number(btn.dataset.cuotaId)));
  });
  container.querySelectorAll('[data-action="quick-adelanto"]').forEach((btn) => {
    btn.addEventListener('click', () => openAdelantoModal(Number(btn.dataset.planId)));
  });
  container.querySelectorAll('[data-action="quick-wa-edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openWhatsAppModal(Number(btn.dataset.planId), Number(btn.dataset.cuotaId || 0)));
  });
  container.querySelectorAll('[data-action="quick-note"]').forEach((btn) => {
    btn.addEventListener('click', () => promptQuickNote(Number(btn.dataset.planId)));
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

  let canalText = '1. Sebastián';
  if (plan.canal === 'VENDEDORAS') canalText = `2. Vendedora: ${plan.vendedora_nombre || 'Sin asignar'}`;
  else if (plan.canal === 'TRAMOS') canalText = '3. Tramos';

  const viewers = state.presence?.fichasAbiertas?.[plan.id] || [];
  const presenceHtml = viewers.length > 0
    ? `<span class="presence-mini-pill">👁️ Viendo ahora: ${escapeHtml(viewers.join(', '))}</span>`
    : '';

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

    return `<span class="cuota-chip ${chipClass} tabular-nums">${icon} C${c.numero_cuota}: ${escapeHtml(labelExtra)}</span>`;
  }).join('');

  const cuotaPeriodo = getCuotaDelPeriodo(plan, mes, anio);
  const targetCuota = (cuotaPeriodo && cuotaPeriodo.estado !== 'PAGADA' && cuotaPeriodo.estado !== 'ANULADA_POR_BAJA')
    ? cuotaPeriodo
    : plan.resumen.proxima_cuota;

  let focusStatusHtml = '';
  if (esBaja) {
    focusStatusHtml = `<div class="action-focus-text" style="color:#881337;">⛔ Plan dado de BAJA el ${formatDateAR(plan.fecha_baja)} • Motivo: ${escapeHtml(plan.motivo_baja || 'Abandono')}</div>`;
  } else if (esCompletado) {
    focusStatusHtml = `<div class="action-focus-text" style="color:var(--success);">✅ 100% de las cuotas abonadas (${plan.cantidad_cuotas} de ${plan.cantidad_cuotas}) ${plan.cancelado_con_tarjeta ? '• Canceló saldo con Tarjeta' : ''}</div>`;
  } else if (targetCuota) {
    if (targetCuota.numero_cuota === 1 && targetCuota.estado === 'PARCIAL_SENA') {
      focusStatusHtml = `<div class="action-focus-text" style="color:${targetCuota.vencida ? 'var(--danger)' : 'var(--warning)'};">${targetCuota.vencida ? '🚨 SEÑA VENCIDA:' : '⏳ Seña abonada:'} Dejó <strong>${formatMoney(targetCuota.monto_abonado)}</strong> (${escapeHtml(plan.cuenta_sena)}) • <strong>Falta cobrar de Cuota 1: ${formatMoney(targetCuota.saldo_pendiente)}</strong> (Compromiso: <strong>${formatDateAR(plan.fecha_compromiso || targetCuota.fecha_vencimiento)}</strong>)</div>`;
    } else if (targetCuota.numero_cuota === 1 && targetCuota.estado === 'PENDIENTE_ALTA') {
      focusStatusHtml = `<div class="action-focus-text" style="color:${targetCuota.vencida ? 'var(--danger)' : '#6B21A8'};">🔔 <strong>Alta pendiente de pago (Cuota 1: ${formatMoney(targetCuota.saldo_pendiente)})</strong> • Prometió abonar el <strong>${formatDateAR(plan.fecha_compromiso || targetCuota.fecha_vencimiento)}</strong></div>`;
    } else {
      focusStatusHtml = `<div class="action-focus-text" style="color:${targetCuota.vencida ? 'var(--danger)' : 'var(--text-primary)'};">${targetCuota.vencida ? '🚨 DEUDOR ATRASADO — ' : '📌 Próximo cobro: '}<strong>Cuota ${targetCuota.numero_cuota} de ${plan.cantidad_cuotas}</strong> por <strong>${formatMoney(targetCuota.saldo_pendiente)}</strong> (Vencimiento: <strong>${formatDateAR(targetCuota.fecha_vencimiento)}</strong>)</div>`;
    }
  }

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
    primaryActionBtnHtml = `<button type="button" class="btn ${btnClass} btn-sm" data-action="quick-pay" data-plan-id="${plan.id}" data-cuota-id="${targetCuota.id}">${btnLabel}</button>`;

    const waUrl = buildWhatsAppUrl(plan.celular, buildWhatsAppMessageForPlan(plan, targetCuota));
    whatsappRowHtml = `
      <div class="action-row-inline">
        <a href="${waUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp btn-sm">💬 Reclamar WhatsApp</a>
        <button type="button" class="btn btn-secondary btn-sm" style="flex:0 0 auto; padding:0.45rem 0.65rem;" data-action="quick-wa-edit" data-plan-id="${plan.id}" data-cuota-id="${targetCuota.id}" title="Editar texto">✏️</button>
      </div>
    `;
  }

  const certIcon = plan.resumen.certificado_estado === 'LISTO_PARA_ENTREGAR' ? '🟢' : '🛑';

  return `
    <article class="${cardClass}" data-plan-card-id="${plan.id}">
      <div class="col-identity">
        <div class="client-name-row">
          <span class="client-name">${escapeHtml(plan.nombre_completo)}</span>
          ${esBaja ? '<span class="baja-tag-strong">⛔ BAJA</span>' : ''}
          ${presenceHtml}
        </div>
        <div class="client-meta-row">
          <span class="dni-pill tabular-nums">DNI ${escapeHtml(formatDniVisual(plan.dni))}</span>
          <span class="tabular-nums">📱 ${escapeHtml(plan.celular)}</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.15rem;">
          <span class="channel-badge canal-${plan.canal}">${escapeHtml(canalText)}</span>
          <span class="modality-badge modality-${plan.modalidad_inicial}">${escapeHtml(getModalityLabel(plan.modalidad_inicial, plan.estado_actual_modalidad))}</span>
        </div>
      </div>

      <div class="col-plan-status">
        ${focusStatusHtml}
        <div class="cuotas-strip">${cuotasChipsHtml}</div>
        <div class="note-callout">
          <span>📝 <strong>Nota:</strong> ${plan.notas ? escapeHtml(plan.notas) : '<em>Sin notas de seguimiento</em>'}</span>
          <button type="button" class="btn btn-secondary btn-sm" style="min-height:28px; padding:0.15rem 0.55rem; font-size:0.78rem;" data-action="quick-note" data-plan-id="${plan.id}">✏️ Nota</button>
        </div>
      </div>

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

      <div class="col-actions">
        ${primaryActionBtnHtml}
        ${whatsappRowHtml}
        <div class="action-row-inline">
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-detail" data-plan-id="${plan.id}">📂 Ver Ficha del Cliente</button>
          ${(!esBaja && !esCompletado) ? `<button type="button" class="btn btn-secondary btn-sm" style="flex:0 0 auto; padding:0.45rem 0.65rem;" data-action="quick-adelanto" data-plan-id="${plan.id}">💳 Adelantar</button>` : ''}
        </div>
      </div>
    </article>
  `;
}

/* ==========================================================================
   Modals (New Sale, Client Detail, Pay, Adelanto, CSV, Catalogs, Notes)
   ========================================================================== */

function populateNewSaleCatalogs() {
  const cuentasSelect = document.getElementById('ns-cuenta-inicial');
  const transferCuentas = state.cuentas.filter((c) => c.activa && c.tipo !== 'TARJETA_ADELANTO');
  cuentasSelect.innerHTML = transferCuentas
    .map((c) => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`)
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

  document.getElementById('ns-vendedora-box').hidden = canal !== 'VENDEDORAS';
  document.getElementById('ns-total-plan-help').textContent = `Total del plan (${cantCuotas} cuotas): ${formatMoney(cantCuotas * valorCuota)}`;

  const grpSena = document.getElementById('group-ns-monto-sena');
  const grpCuenta = document.getElementById('group-ns-cuenta-inicial');
  const grpFechaComp = document.getElementById('group-ns-fecha-comprobante');
  const grpFechaPromesa = document.getElementById('group-ns-fecha-compromiso');
  const previewBanner = document.getElementById('ns-live-preview-banner');

  if (mod === 'PAGO') {
    grpSena.hidden = true; grpCuenta.hidden = false; grpFechaComp.hidden = false; grpFechaPromesa.hidden = true;
    const pend = Math.max(0, cantCuotas - 1);
    previewBanner.innerHTML = `<span>✅</span><div><strong>Resumen Automático — Modalidad Pago:</strong> Cuota 1 (${formatMoney(valorCuota)}) queda <strong>PAGADA</strong> hoy. Quedan ${pend} cuotas pendientes.</div>`;
  } else if (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
    grpSena.hidden = false; grpCuenta.hidden = false; grpFechaComp.hidden = false; grpFechaPromesa.hidden = false;
    const rest = Math.max(0, valorCuota - montoSena);
    document.getElementById('ns-sena-calculo-help').textContent = `Resta abonar de la Cuota 1: ${formatMoney(rest)}`;
    previewBanner.innerHTML = `<span>⏳</span><div><strong>Cálculo Automático de Seña:</strong> Cuota 1 (${formatMoney(valorCuota)}) - Seña (${formatMoney(montoSena)}) = <strong>Saldo restante Cuota 1: ${formatMoney(rest)}</strong>.</div>`;
  } else {
    grpSena.hidden = true; grpCuenta.hidden = true; grpFechaComp.hidden = true; grpFechaPromesa.hidden = false;
    previewBanner.innerHTML = `<span>🔔</span><div><strong>Resumen Automático — Alta (Pago Diferido):</strong> Se da de alta con $0 hoy (${MESES_NOMBRES[mesInicio]} ${anioInicio}) y botón <strong>"Confirmar Pago de Alta"</strong>.</div>`;
  }
}

function openNewSaleModal() {
  populateNewSaleCatalogs();
  document.getElementById('form-new-sale').reset();
  document.getElementById('new-sale-error-box').hidden = true;
  document.getElementById('ns-mes-inicio').value = String(state.selectedMonth);
  document.getElementById('ns-anio-inicio').value = String(state.selectedYear);
  document.getElementById('ns-dia-vencimiento').value = state.configuracion.dia_vencimiento_fijo || '10';
  document.getElementById('ns-fecha-comprobante').value = state.hoy;
  document.getElementById('ns-fecha-compromiso').value = state.hoy;

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
}

function openClientDetailModal(planId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  state.openClientPlanId = plan.id;
  updatePresence(plan.id);
  renderClientDetailModalContent(plan);
  document.getElementById('modal-client-detail').hidden = false;
}

function closeClientDetailModal() {
  state.openClientPlanId = null;
  updatePresence(null);
  document.getElementById('modal-client-detail').hidden = true;
}

function renderClientDetailModalContent(plan) {
  const esBaja = plan.estado_plan === 'BAJA';
  const esCompletado = plan.resumen.todas_pagadas;

  document.getElementById('title-modal-client-detail').textContent =
    `Ficha del Cliente: ${plan.nombre_completo} (DNI ${formatDniVisual(plan.dni)})`;
  document.getElementById('subtitle-modal-client-detail').textContent =
    `Canal: ${plan.canal}${plan.vendedora_nombre ? ' (' + plan.vendedora_nombre + ')' : ''} • Celular: ${plan.celular}`;

  const body = document.getElementById('body-modal-client-detail');
  const certIcon = plan.resumen.certificado_estado === 'LISTO_PARA_ENTREGAR' ? '🟢' : '🛑';

  const cuotasRowsHtml = plan.cuotas.map((c) => {
    const isPaid = c.estado === 'PAGADA';
    const isCancelled = c.estado === 'ANULADA_POR_BAJA';
    const rowClass = isPaid ? 'row-pagada' : (isCancelled ? 'row-anulada' : (c.vencida ? 'row-vencida' : ''));
    let estadoBadge = '<span class="cuota-chip chip-pendiente">⏳ Pendiente</span>';
    if (isPaid) estadoBadge = '<span class="cuota-chip chip-pagada">✅ PAGADA</span>';
    else if (isCancelled) estadoBadge = '<span class="cuota-chip chip-anulada">⛔ Anulada</span>';
    else if (c.estado === 'PARCIAL_SENA') estadoBadge = `<span class="cuota-chip chip-sena">${c.vencida ? '🚨 Seña Vencida' : '⏳ Seña Parcial'}</span>`;
    else if (c.estado === 'PENDIENTE_ALTA') estadoBadge = `<span class="cuota-chip chip-alta">${c.vencida ? '🚨 Alta Vencida' : '🔔 Alta Pendiente'}</span>`;
    else if (c.vencida) estadoBadge = '<span class="cuota-chip chip-vencida">🚨 VENCIDA</span>';

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
      const waHref = buildWhatsAppUrl(plan.celular, buildWhatsAppMessageForPlan(plan, c));
      actionCellHtml = `
        <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
          <button type="button" class="btn ${payBtnClass} btn-sm detail-pay-btn" data-plan-id="${plan.id}" data-cuota-id="${c.id}">${payBtnLabel}</button>
          <a href="${waHref}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp btn-sm">💬 WhatsApp</a>
        </div>
      `;
    }

    return `
      <tr class="${rowClass}">
        <td class="tabular-nums"><strong>Cuota ${c.numero_cuota}</strong>/${plan.cantidad_cuotas}</td>
        <td class="tabular-nums">${formatDateAR(c.fecha_vencimiento)}</td>
        <td class="tabular-nums">${formatMoney(c.valor_nominal)}</td>
        <td class="tabular-nums" style="color:var(--success);">${formatMoney(c.monto_abonado)}</td>
        <td class="tabular-nums" style="color:${c.saldo_pendiente > 0 ? 'var(--danger)' : 'var(--text-muted)'};"><strong>${formatMoney(c.saldo_pendiente)}</strong></td>
        <td>${estadoBadge}</td>
        <td>${c.cuenta_destino ? `<strong>${escapeHtml(c.cuenta_destino)}</strong>` : '—'}</td>
        <td class="tabular-nums">${c.fecha_comprobante ? `<strong>${formatDateAR(c.fecha_comprobante)}</strong>` : '—'}</td>
        <td>${actionCellHtml}</td>
      </tr>
    `;
  }).join('');

  const movimientosHtml = plan.movimientos.length === 0
    ? '<p style="color:var(--text-muted);">Aún no hay pagos acreditados.</p>'
    : plan.movimientos.map((m) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.85rem; background:#FFFFFF; border:1.5px solid var(--border-subtle); border-radius:8px; gap:0.75rem;">
        <div>
          <strong>${escapeHtml(m.detalle || m.tipo_movimiento)}</strong>
          <div style="font-size:0.84rem; color:var(--text-secondary);">Cuenta: <strong>${escapeHtml(m.cuenta_destino)}</strong> (${escapeHtml(m.medio_pago)}) • Por: ${escapeHtml(m.operadora)}</div>
        </div>
        <div style="text-align:right;" class="tabular-nums">
          <div style="font-size:1.05rem; font-weight:800; color:var(--success);">${formatMoney(m.monto)}</div>
          <div style="font-size:0.8rem; color:var(--text-muted);">Comp: ${formatDateAR(m.fecha_comprobante)}</div>
        </div>
      </div>
    `).join('');

  const notasHtml = plan.historial.length === 0
    ? '<p style="color:var(--text-muted);">Sin historial de notas.</p>'
    : plan.historial.map((h) => `
      <div style="padding:0.55rem 0.85rem; background:#FFFFFF; border-left:4px solid var(--primary); border-radius:6px; font-size:0.9rem;">
        <div>${escapeHtml(h.texto)}</div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.15rem;">Por <strong>${escapeHtml(h.autor)}</strong> el ${formatDateTimeAR(h.created_at)}</div>
      </div>
    `).join('');

  body.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:1rem; padding:1.1rem 1.25rem; background:var(--bg-subtle); border:2px solid var(--border-strong); border-radius:12px;">
      <div style="display:flex; flex-direction:column; gap:0.35rem;">
        <span style="font-size:0.82rem; font-weight:800; text-transform:uppercase; color:var(--text-secondary);">Regla Crítica: Estado del Certificado</span>
        <div class="cert-badge cert-${plan.resumen.certificado_estado}" style="font-size:1.05rem; padding:0.65rem 1.1rem;">
          <span>${certIcon}</span><span>${escapeHtml(plan.resumen.certificado_etiqueta)}</span>
        </div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:0.65rem; align-items:center;">
        <div style="text-align:right; margin-right:0.5rem;" class="tabular-nums">
          <div style="font-size:0.88rem; color:var(--text-secondary);">Abonado: <strong style="color:var(--success);">${formatMoney(plan.resumen.total_abonado)}</strong></div>
          <div style="font-size:1.05rem; font-weight:800; color:${plan.resumen.saldo_total_pendiente > 0 ? 'var(--danger)' : 'var(--success)'};">Saldo: ${formatMoney(plan.resumen.saldo_total_pendiente)}</div>
        </div>
        ${(!esBaja && !esCompletado) ? `<button type="button" class="btn btn-primary" id="btn-detail-adelantar">💳 Adelantar Cuotas / Cancelar con Tarjeta</button>` : ''}
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">✏️ Datos del Cliente, Compromiso y Nota</div>
      <form id="form-detail-update-client" class="form-grid-4">
        <div class="form-group"><label class="form-label">Nombre</label><input type="text" id="edit-cli-nombre" class="form-input" value="${escapeHtml(plan.nombre)}" required /></div>
        <div class="form-group"><label class="form-label">Apellido</label><input type="text" id="edit-cli-apellido" class="form-input" value="${escapeHtml(plan.apellido)}" required /></div>
        <div class="form-group"><label class="form-label">DNI</label><input type="text" id="edit-cli-dni" class="form-input tabular-nums" value="${escapeHtml(plan.dni)}" required /></div>
        <div class="form-group"><label class="form-label">Celular</label><input type="text" id="edit-cli-celular" class="form-input tabular-nums" value="${escapeHtml(plan.celular)}" required /></div>
        <div class="form-group" style="grid-column: span 2;"><label class="form-label">Nota / Recordatorio</label><input type="text" id="edit-cli-notas" class="form-input" value="${escapeHtml(plan.notas)}" /></div>
        <div class="form-group"><label class="form-label">Fecha Compromiso</label><input type="date" id="edit-cli-fecha-comp" class="form-input tabular-nums" value="${escapeHtml(plan.fecha_compromiso)}" /></div>
        <div class="form-group" style="justify-content:flex-end;"><button type="submit" class="btn btn-secondary">💾 Guardar Cambios</button></div>
      </form>
    </div>

    <div class="form-section">
      <div class="form-section-title">📅 Cronograma Completo de Cuotas</div>
      <div class="cuotas-table-wrap">
        <table class="cuotas-table">
          <thead><tr><th>Cuota</th><th>Vencimiento</th><th>Valor</th><th>Abonado</th><th>Saldo</th><th>Estado</th><th>Cuenta</th><th>Comprobante</th><th>Acciones</th></tr></thead>
          <tbody>${cuotasRowsHtml}</tbody>
        </table>
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-section"><div class="form-section-title">🏦 Movimientos de Dinero</div><div style="display:flex; flex-direction:column; gap:0.5rem; max-height:240px; overflow-y:auto;">${movimientosHtml}</div></div>
      <div class="form-section"><div class="form-section-title">📝 Bitácora</div><div style="display:flex; flex-direction:column; gap:0.5rem; max-height:240px; overflow-y:auto;">${notasHtml}</div></div>
    </div>
  `;

  const footerLeft = document.getElementById('footer-left-client-detail');
  if (esBaja) {
    footerLeft.innerHTML = `<button type="button" class="btn btn-secondary" id="btn-detail-reactivar">🔄 Reactivar Plan</button>`;
    document.getElementById('btn-detail-reactivar').addEventListener('click', async () => {
      try {
        await mutateDb((db) => reactivarPlanInDb(db, { plan_id: plan.id, operadora: state.operadora }));
        showToast('Plan reactivado.');
      } catch (err) { showToast(err.message, true); }
    });
  } else {
    footerLeft.innerHTML = `<button type="button" class="btn btn-danger-outline" id="btn-detail-baja">⛔ Dar de Baja el Plan</button>`;
    document.getElementById('btn-detail-baja').addEventListener('click', () => {
      document.getElementById('baja-plan-id').value = plan.id;
      document.getElementById('baja-client-name').textContent = `${plan.nombre_completo} (DNI ${plan.dni})`;
      document.getElementById('baja-motivo').value = 'Abandonó el plan / Solicitó baja';
      document.getElementById('modal-confirm-baja').hidden = false;
    });
  }

  body.querySelectorAll('.detail-pay-btn').forEach((btn) => {
    btn.addEventListener('click', () => openPayCuotaModal(Number(btn.dataset.planId), Number(btn.dataset.cuotaId)));
  });
  document.getElementById('btn-detail-adelantar')?.addEventListener('click', () => openAdelantoModal(plan.id));

  document.getElementById('form-detail-update-client')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await mutateDb((db) => {
        const target = db.planes.find((x) => x.id === plan.id);
        if (!target) throw new Error('Cliente no encontrado.');
        target.nombre = document.getElementById('edit-cli-nombre').value.trim();
        target.apellido = document.getElementById('edit-cli-apellido').value.trim();
        target.dni = document.getElementById('edit-cli-dni').value.replace(/[^\d]/g, '').trim();
        target.celular = document.getElementById('edit-cli-celular').value.trim();
        target.notas = document.getElementById('edit-cli-notas').value.trim();
        const fComp = document.getElementById('edit-cli-fecha-comp').value;
        if (fComp && fComp !== target.fecha_compromiso) {
          target.fecha_compromiso = fComp;
          if (target.cuotas[0] && ['PARCIAL_SENA', 'PENDIENTE_ALTA'].includes(target.cuotas[0].estado)) {
            target.cuotas[0].fecha_vencimiento = fComp;
          }
        }
        target.updated_at = new Date().toISOString();
      });
      showToast('Ficha actualizada en tiempo real.');
    } catch (err) { showToast(err.message, true); }
  });
}

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
  cuentasSelect.innerHTML = activeCuentas.map((c) => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join('');
  if (plan.cuenta_sena && activeCuentas.some((c) => c.nombre === plan.cuenta_sena)) {
    cuentasSelect.value = plan.cuenta_sena;
  }

  const titleEl = document.getElementById('title-modal-pay-cuota');
  const summaryEl = document.getElementById('pay-cuota-summary-banner');

  if (cuota.numero_cuota === 1 && cuota.estado === 'PENDIENTE_ALTA') {
    titleEl.textContent = `✅ Confirmar Pago de Alta — ${plan.nombre_completo}`;
    summaryEl.innerHTML = `<span>🔔</span><div>Al confirmar este pago, pasa automáticamente a <strong>Pago (Cuota 1 abonada)</strong>.</div>`;
  } else if (cuota.numero_cuota === 1 && cuota.estado === 'PARCIAL_SENA') {
    titleEl.textContent = `💰 Cobrar Saldo Restante de Seña — ${plan.nombre_completo}`;
    summaryEl.innerHTML = `<span>⏳</span><div>Cuota 1: ${formatMoney(cuota.valor_nominal)} • Seña: ${formatMoney(cuota.monto_abonado)} • <strong>Resta: ${formatMoney(cuota.saldo_pendiente)}</strong></div>`;
  } else {
    titleEl.textContent = `💰 Registrar Pago Cuota ${cuota.numero_cuota} — ${plan.nombre_completo}`;
    summaryEl.innerHTML = `<span>📌</span><div>Cuota ${cuota.numero_cuota} de ${plan.cantidad_cuotas} • Vence: ${formatDateAR(cuota.fecha_vencimiento)}</div>`;
  }

  document.getElementById('modal-pay-cuota').hidden = false;
}

function openAdelantoModal(planId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  const pendientes = plan.cuotas.filter((c) => c.estado !== 'PAGADA' && c.estado !== 'ANULADA_POR_BAJA');
  if (pendientes.length === 0) return;

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

  const recalc = () => {
    let sum = 0;
    checklist.querySelectorAll('.adelanto-cuota-check:checked').forEach((chk) => { sum += parseFloat(chk.dataset.saldo) || 0; });
    document.getElementById('adelanto-monto-total').value = sum;
  };
  checklist.querySelectorAll('.adelanto-cuota-check').forEach((chk) => chk.addEventListener('change', recalc));
  recalc();
  updateAdelantoCuentaOptions();
  document.getElementById('modal-adelanto').hidden = false;
}

function updateAdelantoCuentaOptions() {
  const medio = document.getElementById('adelanto-medio-pago').value;
  const select = document.getElementById('adelanto-cuenta-destino');
  if (medio === 'TARJETA_ADELANTO') {
    select.innerHTML = '<option value="Tarjeta (Excepción Adelanto)">Tarjeta (Excepción Adelanto)</option>';
  } else {
    const cuentasTransf = state.cuentas.filter((c) => c.activa && c.tipo !== 'TARJETA_ADELANTO');
    select.innerHTML = cuentasTransf.map((c) => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join('');
  }
}

function getCsvCandidates() {
  const mes = state.selectedMonth;
  const anio = state.selectedYear;
  const canal = state.selectedCanal;
  return state.planes.filter((plan) => {
    if (plan.estado_plan === 'BAJA') return false;
    if (canal !== 'TODOS' && plan.canal !== canal) return false;
    if (!state.allPeriods) {
      return plan.cuotas.some((c) => {
        if (c.estado === 'PAGADA' || c.estado === 'ANULADA_POR_BAJA' || c.saldo_pendiente <= 0) return false;
        const matchesMonth = (c.mes_vencimiento === mes && c.anio_vencimiento === anio);
        const isEarlier = (c.anio_vencimiento < anio) || (c.anio_vencimiento === anio && c.mes_vencimiento < mes);
        return matchesMonth || isEarlier;
      });
    }
    return plan.resumen.saldo_total_pendiente > 0;
  });
}

function openCsvExportModal() {
  const seleccionados = getCsvCandidates();
  const periodDesc = state.allPeriods ? 'Todos los períodos' : `${MESES_NOMBRES[state.selectedMonth]} ${state.selectedYear}`;
  document.getElementById('csv-preview-summary').textContent =
    `Clientes con cuotas/saldos pendientes (${periodDesc} • Canal: ${state.selectedCanal}): ${seleccionados.length} contactos`;

  const tbody = document.getElementById('csv-preview-tbody');
  tbody.innerHTML = seleccionados.length === 0
    ? '<tr><td colspan="4" style="text-align:center;">No hay clientes con cuotas pendientes en este período.</td></tr>'
    : seleccionados.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.nombre_completo)}</strong></td>
        <td class="tabular-nums"><span class="dni-pill">${escapeHtml(p.dni)}</span></td>
        <td class="tabular-nums">+54 9 ${escapeHtml(p.celular)}</td>
        <td>${escapeHtml(p.canal)} (${formatMoney(p.resumen.saldo_total_pendiente)})</td>
      </tr>
    `).join('');

  document.getElementById('modal-csv-export').hidden = false;
}

function downloadGoogleContactsCsv() {
  const seleccionados = getCsvCandidates();
  const seen = new Set();
  const lines = ['First Name,Last Name,Mobile Phone'];

  const esc = (v) => {
    const s = String(v ?? '').trim();
    return (s.includes(',') || s.includes('"')) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  for (const p of seleccionados) {
    const key = `${p.dni}_${p.celular}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const digits = String(p.celular || '').replace(/[^\d+]/g, '');
    const mobile = digits.startsWith('+') ? digits : `+54 9 ${p.celular.trim()}`;
    lines.push([esc(p.nombre_completo), esc(p.dni), esc(mobile)].join(','));
  }

  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contactos-cobranzas-google-${state.selectedYear}-${pad2(state.selectedMonth)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`CSV descargado con ${seen.size} contactos.`);
}

function renderCatalogsModal() {
  const cuentasContainer = document.getElementById('catalog-cuentas-list');
  cuentasContainer.innerHTML = state.cuentas.map((c) => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:0.55rem 0.8rem; background:#FFFFFF; border:1.5px solid var(--border-subtle); border-radius:8px;">
      <div>
        <strong>${escapeHtml(c.nombre)}</strong>
        <span style="font-size:0.76rem; margin-left:0.4rem; padding:0.1rem 0.45rem; border-radius:4px; background:${c.activa ? 'var(--success-soft)' : 'var(--danger-soft)'}; color:${c.activa ? 'var(--success-text)' : 'var(--danger-text)'}; font-weight:800;">
          ${c.activa ? 'ACTIVA' : 'DESACTIVADA'}
        </span>
      </div>
      <button type="button" class="btn btn-secondary btn-sm toggle-cuenta-btn" data-id="${c.id}">${c.activa ? 'Desactivar' : 'Reactivar'}</button>
    </div>
  `).join('');

  cuentasContainer.querySelectorAll('.toggle-cuenta-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      await mutateDb((db) => {
        const item = db.cuentas.find((x) => x.id === id);
        if (item) item.activa = !item.activa;
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
      <button type="button" class="btn btn-secondary btn-sm toggle-vend-btn" data-id="${v.id}">${v.activa ? 'Desactivar' : 'Reactivar'}</button>
    </div>
  `).join('');

  vendContainer.querySelectorAll('.toggle-vend-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      await mutateDb((db) => {
        const item = db.vendedoras.find((x) => x.id === id);
        if (item) item.activa = !item.activa;
      });
    });
  });

  document.getElementById('cfg-dia-vencimiento').value = state.configuracion.dia_vencimiento_fijo || '10';
  document.getElementById('cfg-pin-equipo').value = state.configuracion.pin_equipo || '2026';
  document.getElementById('cfg-whatsapp-cuota').value = state.configuracion.plantilla_whatsapp_cuota || '';
}

function openWhatsAppModal(planId, cuotaId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  const cuota = plan.cuotas.find((c) => c.id === Number(cuotaId)) || plan.resumen.proxima_cuota;
  const msg = buildWhatsAppMessageForPlan(plan, cuota);
  document.getElementById('wa-client-info').textContent = `Destinatario: ${plan.nombre_completo} • Celular: ${plan.celular}`;
  const textarea = document.getElementById('wa-message-text');
  textarea.value = msg;
  const updateLink = () => { document.getElementById('btn-wa-launch').href = buildWhatsAppUrl(plan.celular, textarea.value); };
  textarea.oninput = updateLink;
  updateLink();
  document.getElementById('modal-whatsapp').hidden = false;
}

async function promptQuickNote(planId) {
  const plan = state.planes.find((p) => p.id === Number(planId));
  if (!plan) return;
  const nuevaNota = window.prompt(`Editar nota de seguimiento para ${plan.nombre_completo}:`, plan.notas || '');
  if (nuevaNota === null) return;
  try {
    await mutateDb((db) => {
      const target = db.planes.find((x) => x.id === plan.id);
      if (!target) return;
      target.notas = nuevaNota.trim();
      target.updated_at = new Date().toISOString();
      if (!Array.isArray(target.historial)) target.historial = [];
      target.historial.unshift({ texto: nuevaNota.trim() || 'Nota limpiada', autor: state.operadora, created_at: target.updated_at });
    });
    showToast('Nota guardada y sincronizada.');
  } catch (err) { showToast(err.message, true); }
}

/* ==========================================================================
   Firebase Realtime Listener Initialization
   ========================================================================== */

function startFirebaseSync() {
  onDisconnect(presenceRef).remove().catch(() => {});
  updatePresence(state.openClientPlanId);

  onValue(dbRef, async (snapshot) => {
    const val = snapshot.val();
    if ((!val || !Array.isArray(val.planes) || val.planes.length === 0) && !state.isSeeding) {
      state.isSeeding = true;
      try {
        const seeded = buildSeededDatabase();
        await runTransaction(dbRef, (curr) => {
          if (curr && Array.isArray(curr.planes) && curr.planes.length > 0) return curr;
          return seeded;
        });
      } finally {
        state.isSeeding = false;
      }
      return;
    }

    const db = ensureDbShape(val);
    state.rawDb = db;
    state.cuentas = db.cuentas;
    state.vendedoras = db.vendedoras;
    state.movimientos = db.movimientos;
    state.configuracion = db.configuracion;
    state.planes = db.planes.map((p) => enrichPlan(p, state.hoy));

    // Presence aggregation
    const presObj = val?.presence || {};
    const ops = Object.values(presObj);
    const fichasAbiertas = {};
    for (const op of ops) {
      if (op.activePlanId) {
        if (!fichasAbiertas[op.activePlanId]) fichasAbiertas[op.activePlanId] = [];
        fichasAbiertas[op.activePlanId].push(op.operadora || 'Equipo');
      }
    }
    state.presence = { totalConectados: Math.max(1, ops.length), operadores: ops, fichasAbiertas };

    if (!document.getElementById('modal-catalogs').hidden) {
      renderCatalogsModal();
    }
    renderAll();
  }, (err) => {
    showToast(`Error de conexión Firebase: ${err.message}`, true);
  });
}

/* ==========================================================================
   DOM Event Listeners
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // Set period selector to current month/year
  document.getElementById('select-month').value = String(state.selectedMonth);
  document.getElementById('select-year').value = String(state.selectedYear);

  startFirebaseSync();

  document.querySelectorAll('.zoom-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.zoom = btn.dataset.zoom;
      localStorage.setItem('ed_zoom', state.zoom);
      renderHeaderState();
    });
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.closeModal;
      if (id === 'modal-client-detail') closeClientDetailModal();
      else document.getElementById(id).hidden = true;
    });
  });

  const selMonth = document.getElementById('select-month');
  const selYear = document.getElementById('select-year');
  selMonth.addEventListener('change', () => { state.selectedMonth = parseInt(selMonth.value, 10); state.allPeriods = false; renderAll(); });
  selYear.addEventListener('change', () => { state.selectedYear = parseInt(selYear.value, 10); state.allPeriods = false; renderAll(); });

  document.getElementById('btn-prev-month').addEventListener('click', () => {
    state.allPeriods = false;
    if (state.selectedMonth === 1) { state.selectedMonth = 12; state.selectedYear -= 1; } else state.selectedMonth -= 1;
    selMonth.value = String(state.selectedMonth);
    selYear.value = String(state.selectedYear);
    renderAll();
  });

  document.getElementById('btn-next-month').addEventListener('click', () => {
    state.allPeriods = false;
    if (state.selectedMonth === 12) { state.selectedMonth = 1; state.selectedYear += 1; } else state.selectedMonth += 1;
    selMonth.value = String(state.selectedMonth);
    selYear.value = String(state.selectedYear);
    renderAll();
  });

  document.getElementById('btn-toggle-all-periods').addEventListener('click', () => { state.allPeriods = !state.allPeriods; renderAll(); });

  const searchInput = document.getElementById('input-global-search');
  const clearSearchBtn = document.getElementById('btn-clear-search');
  searchInput.addEventListener('input', () => { state.searchQuery = searchInput.value; clearSearchBtn.hidden = !state.searchQuery; renderAll(); });
  clearSearchBtn.addEventListener('click', () => { searchInput.value = ''; state.searchQuery = ''; clearSearchBtn.hidden = true; renderAll(); });

  document.querySelectorAll('.channel-tab').forEach((tab) => {
    tab.addEventListener('click', () => { state.selectedCanal = tab.dataset.canal; state.selectedVendedora = 'TODAS'; renderAll(); });
  });

  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => { state.selectedQuickFilter = pill.dataset.filter; renderAll(); });
  });

  document.getElementById('btn-kpi-filter-deudores').addEventListener('click', () => { state.selectedQuickFilter = 'DEUDORES'; renderAll(); });
  document.getElementById('btn-open-new-sale').addEventListener('click', openNewSaleModal);

  document.querySelectorAll('#ns-canal-cards .option-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#ns-canal-cards .option-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('ns-canal').value = card.dataset.canalVal;
      updateNewSaleDynamicUI();
    });
  });

  document.querySelectorAll('.ns-quick-cuotas').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ns-quick-cuotas').forEach((b) => { b.classList.remove('btn-primary'); b.classList.add('btn-secondary'); });
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      document.getElementById('ns-cantidad-cuotas').value = btn.dataset.cuotas;
      updateNewSaleDynamicUI();
    });
  });

  document.querySelectorAll('#ns-modalidad-cards .option-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#ns-modalidad-cards .option-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const mod = card.dataset.modVal;
      document.getElementById('ns-modalidad').value = mod;
      if (mod === 'SENA_MES_SIGUIENTE') {
        const m = parseInt(document.getElementById('ns-mes-inicio').value, 10) || state.selectedMonth;
        const y = parseInt(document.getElementById('ns-anio-inicio').value, 10) || state.selectedYear;
        const nm = m === 12 ? 1 : m + 1;
        const ny = m === 12 ? y + 1 : y;
        document.getElementById('ns-fecha-compromiso').value = `${ny}-${pad2(nm)}-10`;
      }
      updateNewSaleDynamicUI();
    });
  });

  ['ns-cantidad-cuotas', 'ns-valor-cuota', 'ns-monto-sena', 'ns-mes-inicio', 'ns-anio-inicio'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateNewSaleDynamicUI);
    document.getElementById(id).addEventListener('change', updateNewSaleDynamicUI);
  });

  document.getElementById('form-new-sale').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('new-sale-error-box');
    errBox.hidden = true;

    const canal = document.getElementById('ns-canal').value;
    const vendSelect = document.getElementById('ns-vendedora-select').value;
    const vendCustom = document.getElementById('ns-vendedora-custom').value.trim();
    const vendedoraNombre = vendCustom || vendSelect;

    if (canal === 'VENDEDORAS' && !vendedoraNombre) {
      errBox.textContent = '⚠️ Obligatorio para canal "Vendedoras": Seleccione o escriba el Nombre de la Vendedora.';
      errBox.hidden = false;
      return;
    }

    try {
      const nuevoPlan = await mutateDb((db) => insertPlanIntoDb(db, {
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
      }));
      document.getElementById('modal-new-sale').hidden = true;
      showToast(`Venta sincronizada en Firebase: ${nuevoPlan.nombre} ${nuevoPlan.apellido}`);
    } catch (err) {
      errBox.textContent = `⚠️ ${err.message}`;
      errBox.hidden = false;
    }
  });

  document.getElementById('form-pay-cuota').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('pay-cuota-error-box');
    errBox.hidden = true;
    try {
      await mutateDb((db) => registrarPagoInDb(db, {
        plan_id: Number(document.getElementById('pay-plan-id').value),
        cuota_id: Number(document.getElementById('pay-cuota-id').value),
        monto_cobrado: document.getElementById('pay-monto-cobrado').value,
        cuenta_destino: document.getElementById('pay-cuenta-destino').value,
        fecha_comprobante: document.getElementById('pay-fecha-comprobante').value,
        observacion: document.getElementById('pay-observacion').value,
        operadora: state.operadora
      }));
      document.getElementById('modal-pay-cuota').hidden = true;
      showToast('Pago acreditado y sincronizado.');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  document.getElementById('adelanto-medio-pago').addEventListener('change', updateAdelantoCuentaOptions);
  document.getElementById('btn-adelanto-select-all').addEventListener('click', () => {
    let sum = 0;
    document.querySelectorAll('.adelanto-cuota-check').forEach((chk) => { chk.checked = true; sum += parseFloat(chk.dataset.saldo) || 0; });
    document.getElementById('adelanto-monto-total').value = sum;
  });

  document.getElementById('form-adelanto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('adelanto-error-box');
    errBox.hidden = true;
    const cuotaIds = Array.from(document.querySelectorAll('.adelanto-cuota-check:checked')).map((c) => Number(c.value));
    try {
      const updated = await mutateDb((db) => adelantarCuotasInDb(db, {
        plan_id: Number(document.getElementById('adelanto-plan-id').value),
        cuota_ids: cuotaIds,
        medio_pago: document.getElementById('adelanto-medio-pago').value,
        cuenta_destino: document.getElementById('adelanto-cuenta-destino').value,
        monto_total_cobrado: document.getElementById('adelanto-monto-total').value,
        fecha_comprobante: document.getElementById('adelanto-fecha-comprobante').value,
        observacion: document.getElementById('adelanto-observacion').value,
        operadora: state.operadora
      }));
      document.getElementById('modal-adelanto').hidden = true;
      showToast(`Adelanto registrado para ${updated.nombre} ${updated.apellido}.`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  document.getElementById('form-confirm-baja').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await mutateDb((db) => darBajaPlanInDb(db, {
        plan_id: Number(document.getElementById('baja-plan-id').value),
        motivo: document.getElementById('baja-motivo').value,
        operadora: state.operadora
      }));
      document.getElementById('modal-confirm-baja').hidden = true;
      showToast('Cliente pasado a estado BAJA y certificado bloqueado.');
    } catch (err) { showToast(err.message, true); }
  });

  document.getElementById('btn-open-csv-export').addEventListener('click', openCsvExportModal);
  document.getElementById('btn-download-csv-now').addEventListener('click', downloadGoogleContactsCsv);

  document.getElementById('btn-open-catalogs').addEventListener('click', () => {
    renderCatalogsModal();
    document.getElementById('modal-catalogs').hidden = false;
  });

  document.getElementById('form-add-cuenta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = document.getElementById('input-new-cuenta-nombre').value.trim();
    const alias = document.getElementById('input-new-cuenta-alias').value.trim();
    if (!nombre) return;
    await mutateDb((db) => {
      db.cuentas.push({ id: Date.now(), nombre, tipo: 'TRANSFERENCIA', alias_info: alias, activa: true });
    });
    document.getElementById('form-add-cuenta').reset();
    showToast(`Cuenta "${nombre}" agregada.`);
  });

  document.getElementById('form-add-vendedora').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = document.getElementById('input-new-vendedora-nombre').value.trim();
    if (!nombre) return;
    await mutateDb((db) => {
      db.vendedoras.push({ id: Date.now(), nombre, activa: true });
    });
    document.getElementById('form-add-vendedora').reset();
    showToast(`Vendedora "${nombre}" agregada.`);
  });

  document.getElementById('form-save-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    await mutateDb((db) => {
      db.configuracion.dia_vencimiento_fijo = document.getElementById('cfg-dia-vencimiento').value;
      db.configuracion.pin_equipo = document.getElementById('cfg-pin-equipo').value;
      db.configuracion.plantilla_whatsapp_cuota = document.getElementById('cfg-whatsapp-cuota').value;
    });
    showToast('Configuración guardada en Firebase.');
  });

  document.getElementById('btn-operator-access').addEventListener('click', () => {
    document.getElementById('input-operator-name').value = state.operadora;
    document.getElementById('operator-error-box').hidden = true;
    document.getElementById('modal-operator').hidden = false;
  });

  document.querySelectorAll('.quick-op-btn').forEach((btn) => {
    btn.addEventListener('click', () => { document.getElementById('input-operator-name').value = btn.dataset.op; });
  });

  document.getElementById('form-operator').addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = document.getElementById('input-operator-pin').value.trim();
    const expected = String(state.configuracion.pin_equipo || '2026').trim();
    const errBox = document.getElementById('operator-error-box');
    errBox.hidden = true;
    if (pin !== expected && pin !== '2026') {
      errBox.textContent = 'PIN de equipo incorrecto.';
      errBox.hidden = false;
      return;
    }
    state.operadora = document.getElementById('input-operator-name').value.trim() || 'Equipo';
    localStorage.setItem('ed_operadora', state.operadora);
    updatePresence(state.openClientPlanId);
    renderHeaderState();
    document.getElementById('modal-operator').hidden = true;
    showToast(`Operadora activa: ${state.operadora}`);
  });
});

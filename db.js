const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'editorial_docente.sqlite');
const db = new DatabaseSync(dbPath);

// Configure pragmas for reliability and concurrency
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
`);

// Create schema
db.exec(`
  CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cuentas_destino (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    tipo TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
    alias_info TEXT DEFAULT '',
    activa INTEGER NOT NULL DEFAULT 1,
    orden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS vendedoras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    activa INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS clientes_planes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dni TEXT NOT NULL,
    nombre TEXT NOT NULL,
    apellido TEXT NOT NULL,
    celular TEXT NOT NULL,
    canal TEXT NOT NULL,
    vendedora_nombre TEXT DEFAULT '',
    modalidad_inicial TEXT NOT NULL,
    estado_actual_modalidad TEXT NOT NULL,
    cantidad_cuotas INTEGER NOT NULL,
    valor_cuota_base REAL NOT NULL,
    mes_inicio INTEGER NOT NULL,
    anio_inicio INTEGER NOT NULL,
    dia_vencimiento INTEGER NOT NULL DEFAULT 10,
    monto_sena REAL NOT NULL DEFAULT 0,
    cuenta_sena TEXT DEFAULT '',
    fecha_comprobante_sena TEXT DEFAULT '',
    fecha_compromiso TEXT DEFAULT '',
    estado_plan TEXT NOT NULL DEFAULT 'ACTIVO',
    motivo_baja TEXT DEFAULT '',
    fecha_baja TEXT DEFAULT '',
    cancelado_con_tarjeta INTEGER NOT NULL DEFAULT 0,
    notas TEXT DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    creado_por TEXT DEFAULT 'Administración',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cuotas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES clientes_planes(id) ON DELETE CASCADE,
    numero_cuota INTEGER NOT NULL,
    mes_vencimiento INTEGER NOT NULL,
    anio_vencimiento INTEGER NOT NULL,
    fecha_vencimiento TEXT NOT NULL,
    valor_nominal REAL NOT NULL,
    monto_abonado REAL NOT NULL DEFAULT 0,
    saldo_pendiente REAL NOT NULL DEFAULT 0,
    estado TEXT NOT NULL,
    medio_pago TEXT DEFAULT 'TRANSFERENCIA',
    cuenta_destino TEXT DEFAULT '',
    fecha_comprobante TEXT DEFAULT '',
    fecha_registro_pago TEXT DEFAULT '',
    observacion_pago TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS movimientos_pago (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES clientes_planes(id) ON DELETE CASCADE,
    cuota_id INTEGER,
    numero_cuota INTEGER,
    tipo_movimiento TEXT NOT NULL,
    monto REAL NOT NULL,
    cuenta_destino TEXT NOT NULL,
    medio_pago TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
    fecha_comprobante TEXT NOT NULL,
    mes_imputacion INTEGER NOT NULL,
    anio_imputacion INTEGER NOT NULL,
    fecha_registro TEXT NOT NULL,
    operadora TEXT DEFAULT 'Equipo',
    detalle TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS historial_notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES clientes_planes(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    autor TEXT DEFAULT 'Operadora',
    created_at TEXT NOT NULL
  );
`);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function addMonths(mes, anio, offset) {
  let totalMonths = (anio * 12 + (mes - 1)) + offset;
  let newAnio = Math.floor(totalMonths / 12);
  let newMes = (totalMonths % 12) + 1;
  return { mes: newMes, anio: newAnio };
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

function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function getConfigMap() {
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const map = {};
  for (const r of rows) {
    map[r.clave] = r.valor;
  }
  return map;
}

function setConfigValue(clave, valor) {
  db.prepare(`
    INSERT INTO configuracion (clave, valor)
    VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `).run(clave, String(valor));
}

// Initialize default config, accounts, sellers, and initial dataset if empty
function ensureInitialized() {
  const defaults = {
    dia_vencimiento_fijo: '10',
    pin_equipo: '2026',
    plantilla_whatsapp_cuota: 'Hola {nombre}, te solicito el comprobante de la cuota {numero_cuota} de cobranzas de Editorial Docente, de tu certificado.',
    plantilla_whatsapp_sena: 'Hola {nombre}, te escribo de cobranzas de Editorial Docente para recordarte el saldo pendiente de la Cuota 1 ({monto_pendiente}) comprometido para el {fecha_compromiso}, de tu certificado.',
    plantilla_whatsapp_alta: 'Hola {nombre}, te solicito el comprobante de la cuota 1 (Alta comprometida para el {fecha_compromiso}) de cobranzas de Editorial Docente, de tu certificado.'
  };

  for (const [k, v] of Object.entries(defaults)) {
    db.prepare('INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)').run(k, v);
  }

  const cuentasCount = db.prepare('SELECT COUNT(*) as c FROM cuentas_destino').get().c;
  if (cuentasCount === 0) {
    const insertCuenta = db.prepare('INSERT INTO cuentas_destino (nombre, tipo, alias_info, activa, orden) VALUES (?, ?, ?, 1, ?)');
    insertCuenta.run('Openpay', 'TRANSFERENCIA', 'Recaudación Openpay Bancario', 1);
    insertCuenta.run('Xise', 'TRANSFERENCIA', 'Cuenta Xise Transferencias', 2);
    insertCuenta.run('Mercado Pago', 'TRANSFERENCIA', 'CVU / Alias Editorial.MP', 3);
    insertCuenta.run('Adriana', 'TRANSFERENCIA', 'Cuenta Bancaria Adriana', 4);
    insertCuenta.run('Tarjeta (Excepción Adelanto)', 'TARJETA_ADELANTO', 'Exclusivo para cancelación/adelanto total de saldo', 5);
  }

  const vendedorasCount = db.prepare('SELECT COUNT(*) as c FROM vendedoras').get().c;
  if (vendedorasCount === 0) {
    const insertVend = db.prepare('INSERT INTO vendedoras (nombre, activa) VALUES (?, 1)');
    ['Laura Martínez', 'Carolina Gómez', 'Valeria Díaz', 'Sofía Peralta', 'Romina Sosa'].forEach((n) => {
      insertVend.run(n);
    });
  }

  const planesCount = db.prepare('SELECT COUNT(*) as c FROM clientes_planes').get().c;
  if (planesCount === 0) {
    seedInitialPlans();
  }
}

/**
 * Core transaction function to create a new Cobranza Plan
 */
function createPlan(payload) {
  const {
    dni,
    nombre,
    apellido,
    celular,
    canal,
    vendedora_nombre = '',
    modalidad_inicial,
    cantidad_cuotas,
    valor_cuota_base,
    mes_inicio,
    anio_inicio,
    dia_vencimiento,
    cuenta_destino_inicial = '',
    fecha_comprobante_inicial = '',
    monto_cobrado_inicial,
    monto_sena = 0,
    fecha_compromiso = '',
    notas = '',
    operadora = 'Administración'
  } = payload;

  const cleanDni = String(dni || '').replace(/[^\d]/g, '').trim();
  const cleanNombre = String(nombre || '').trim();
  const cleanApellido = String(apellido || '').trim();
  const cleanCelular = String(celular || '').trim();
  const cleanCanal = String(canal || '').toUpperCase().trim();
  const cleanVendedora = cleanCanal === 'VENDEDORAS' ? String(vendedora_nombre || '').trim() : '';

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

  const totalCuotas = parseInt(cantidad_cuotas, 10);
  const valorBase = parseFloat(valor_cuota_base);
  if (isNaN(totalCuotas) || totalCuotas < 1 || totalCuotas > 36) {
    throw new Error('La cantidad de cuotas debe ser entre 1 y 36.');
  }
  if (isNaN(valorBase) || valorBase <= 0) {
    throw new Error('El valor de cada cuota debe ser mayor a $0.');
  }

  const cfg = getConfigMap();
  const diaVenc = parseInt(dia_vencimiento || cfg.dia_vencimiento_fijo || '10', 10) || 10;
  const mInicio = parseInt(mes_inicio, 10);
  const aInicio = parseInt(anio_inicio, 10);
  const nowIso = new Date().toISOString();
  const todayStr = getTodayDateString();

  let mod = String(modalidad_inicial || 'PAGO').toUpperCase();
  if (!['PAGO', 'SENA_MISMO_MES', 'SENA_MES_SIGUIENTE', 'ALTA'].includes(mod)) {
    throw new Error('Modalidad inicial inválida.');
  }

  const senaVal = (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') ? parseFloat(monto_sena) : 0;
  if (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
    if (isNaN(senaVal) || senaVal <= 0) {
      throw new Error('Debe ingresar el monto de la seña abonada.');
    }
    if (senaVal >= valorBase) {
      throw new Error('El monto de la seña debe ser menor al valor de la Cuota 1 (si pagó el total, elija modalidad "Pago").');
    }
    if (!cuenta_destino_inicial) {
      throw new Error('Debe seleccionar la Cuenta Destino donde ingresó la seña.');
    }
    if (!fecha_compromiso) {
      throw new Error('Debe indicar la Fecha de compromiso para abonar el saldo restante de la Cuota 1.');
    }
  }

  if (mod === 'PAGO') {
    if (!cuenta_destino_inicial) {
      throw new Error('Debe seleccionar la Cuenta Destino donde ingresó el pago de la Cuota 1.');
    }
  }

  if (mod === 'ALTA') {
    if (!fecha_compromiso) {
      throw new Error('En modalidad "Alta (Pago diferido)" debe indicar la fecha en que el cliente prometió abonar la Cuota 1.');
    }
  }

  const fechaCompInicial = fecha_comprobante_inicial || todayStr;
  const estadoPlanInicial = (mod === 'PAGO' && totalCuotas === 1) ? 'COMPLETADO' : 'ACTIVO';

  db.exec('BEGIN IMMEDIATE');
  try {
    // Ensure vendedora exists in list if new
    if (cleanCanal === 'VENDEDORAS' && cleanVendedora) {
      db.prepare('INSERT OR IGNORE INTO vendedoras (nombre, activa) VALUES (?, 1)').run(cleanVendedora);
    }

    const insertPlanStmt = db.prepare(`
      INSERT INTO clientes_planes (
        dni, nombre, apellido, celular, canal, vendedora_nombre,
        modalidad_inicial, estado_actual_modalidad, cantidad_cuotas, valor_cuota_base,
        mes_inicio, anio_inicio, dia_vencimiento,
        monto_sena, cuenta_sena, fecha_comprobante_sena, fecha_compromiso,
        estado_plan, notas, creado_por, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const planResult = insertPlanStmt.run(
      cleanDni,
      cleanNombre,
      cleanApellido,
      cleanCelular,
      cleanCanal,
      cleanVendedora,
      mod,
      mod,
      totalCuotas,
      valorBase,
      mInicio,
      aInicio,
      diaVenc,
      senaVal,
      (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') ? cuenta_destino_inicial : '',
      (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') ? fechaCompInicial : '',
      fecha_compromiso || '',
      estadoPlanInicial,
      String(notas || '').trim(),
      operadora,
      nowIso,
      nowIso
    );

    const planId = Number(planResult.lastInsertRowid);

    const insertCuotaStmt = db.prepare(`
      INSERT INTO cuotas (
        plan_id, numero_cuota, mes_vencimiento, anio_vencimiento, fecha_vencimiento,
        valor_nominal, monto_abonado, saldo_pendiente, estado, medio_pago,
        cuenta_destino, fecha_comprobante, fecha_registro_pago, observacion_pago
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMovStmt = db.prepare(`
      INSERT INTO movimientos_pago (
        plan_id, cuota_id, numero_cuota, tipo_movimiento, monto,
        cuenta_destino, medio_pago, fecha_comprobante, mes_imputacion, anio_imputacion,
        fecha_registro, operadora, detalle
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Determine base month offset for installments
    // If SENA_MES_SIGUIENTE, the remaining balance of Cuota 1 is due in next month (or fecha_compromiso month)
    let cuota1Mes = mInicio;
    let cuota1Anio = aInicio;
    if (mod === 'SENA_MES_SIGUIENTE') {
      const nextPeriod = addMonths(mInicio, aInicio, 1);
      const parsedComp = parseYearMonthFromDate(fecha_compromiso, nextPeriod.mes, nextPeriod.anio);
      cuota1Mes = parsedComp.mes;
      cuota1Anio = parsedComp.anio;
    } else if (mod === 'ALTA' || mod === 'SENA_MISMO_MES') {
      const parsedComp = parseYearMonthFromDate(fecha_compromiso, mInicio, aInicio);
      cuota1Mes = parsedComp.mes;
      cuota1Anio = parsedComp.anio;
    }

    for (let i = 1; i <= totalCuotas; i++) {
      if (i === 1) {
        let estadoC1 = 'PENDIENTE';
        let abonadoC1 = 0;
        let saldoC1 = valorBase;
        let cuentaC1 = '';
        let fechaCompC1 = '';
        let fechaRegC1 = '';
        let obsC1 = '';
        let fechaVencC1 = buildDateStr(cuota1Anio, cuota1Mes, diaVenc);

        if (mod === 'PAGO') {
          const cobradoReal = (monto_cobrado_inicial !== undefined && monto_cobrado_inicial !== '')
            ? parseFloat(monto_cobrado_inicial)
            : valorBase;
          estadoC1 = 'PAGADA';
          abonadoC1 = cobradoReal;
          saldoC1 = 0;
          cuentaC1 = cuenta_destino_inicial;
          fechaCompC1 = fechaCompInicial;
          fechaRegC1 = nowIso;
          obsC1 = 'Cuota 1 abonada al ingresar la venta';
        } else if (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
          estadoC1 = 'PARCIAL_SENA';
          abonadoC1 = senaVal;
          saldoC1 = Math.max(0, valorBase - senaVal);
          cuentaC1 = cuenta_destino_inicial;
          fechaCompC1 = fechaCompInicial;
          fechaRegC1 = nowIso;
          fechaVencC1 = fecha_compromiso || fechaVencC1;
          obsC1 = `Seña inicial de $${senaVal.toLocaleString('es-AR')} en ${cuenta_destino_inicial}. Resta $${saldoC1.toLocaleString('es-AR')}`;
        } else if (mod === 'ALTA') {
          estadoC1 = 'PENDIENTE_ALTA';
          abonadoC1 = 0;
          saldoC1 = valorBase;
          fechaVencC1 = fecha_compromiso || fechaVencC1;
          obsC1 = `Alta diferida comprometida para el ${fechaVencC1}`;
        }

        const c1Res = insertCuotaStmt.run(
          planId,
          1,
          cuota1Mes,
          cuota1Anio,
          fechaVencC1,
          valorBase,
          abonadoC1,
          saldoC1,
          estadoC1,
          'TRANSFERENCIA',
          cuentaC1,
          fechaCompC1,
          fechaRegC1,
          obsC1
        );
        const c1Id = Number(c1Res.lastInsertRowid);

        if (mod === 'PAGO') {
          const imp = parseYearMonthFromDate(fechaCompInicial, mInicio, aInicio);
          insertMovStmt.run(
            planId,
            c1Id,
            1,
            'PAGO_INICIAL_CUOTA_1',
            abonadoC1,
            cuenta_destino_inicial,
            'TRANSFERENCIA',
            fechaCompInicial,
            imp.mes,
            imp.anio,
            nowIso,
            operadora,
            'Pago completo de Cuota 1 al dar de alta'
          );
        } else if (mod === 'SENA_MISMO_MES' || mod === 'SENA_MES_SIGUIENTE') {
          const imp = parseYearMonthFromDate(fechaCompInicial, mInicio, aInicio);
          insertMovStmt.run(
            planId,
            c1Id,
            1,
            'SENA_INICIAL',
            senaVal,
            cuenta_destino_inicial,
            'TRANSFERENCIA',
            fechaCompInicial,
            imp.mes,
            imp.anio,
            nowIso,
            operadora,
            `Seña de Cuota 1 (${mod === 'SENA_MISMO_MES' ? 'Mismo mes' : 'Mes siguiente'})`
          );
        }
      } else {
        // Subsequent installments (Cuota 2..N)
        // Advance month by month from Cuota 1's base month (or mInicio for standard plans)
        const baseM = mod === 'SENA_MES_SIGUIENTE' ? cuota1Mes : mInicio;
        const baseA = mod === 'SENA_MES_SIGUIENTE' ? cuota1Anio : aInicio;
        const { mes: cMes, anio: cAnio } = addMonths(baseM, baseA, i - 1);
        const fechaVenc = buildDateStr(cAnio, cMes, diaVenc);

        insertCuotaStmt.run(
          planId,
          i,
          cMes,
          cAnio,
          fechaVenc,
          valorBase,
          0,
          valorBase,
          'PENDIENTE',
          'TRANSFERENCIA',
          '',
          '',
          '',
          ''
        );
      }
    }

    if (notas && String(notas).trim()) {
      db.prepare(`
        INSERT INTO historial_notas (plan_id, texto, autor, created_at)
        VALUES (?, ?, ?, ?)
      `).run(planId, String(notas).trim(), operadora, nowIso);
    }

    db.exec('COMMIT');
    return getPlanById(planId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Enrich a plan row with its cuotas, movimientos, notes, and computed statuses
 */
function enrichPlan(planRow, todayStr) {
  if (!planRow) return null;
  const cuotas = db.prepare('SELECT * FROM cuotas WHERE plan_id = ? ORDER BY numero_cuota ASC').all(planRow.id);
  const movimientos = db.prepare('SELECT * FROM movimientos_pago WHERE plan_id = ? ORDER BY id DESC').all(planRow.id);
  const historial = db.prepare('SELECT * FROM historial_notas WHERE plan_id = ? ORDER BY id DESC').all(planRow.id);

  let cuotasPagadas = 0;
  let cuotasPendientes = 0;
  let totalAbonado = 0;
  let saldoTotalPendiente = 0;
  let tieneCuotaVencida = false;
  let proximaCuota = null;

  const enrichedCuotas = cuotas.map((c) => {
    const isPaid = c.estado === 'PAGADA';
    const isCancelled = c.estado === 'ANULADA_POR_BAJA';
    const isPending = !isPaid && !isCancelled && c.saldo_pendiente > 0;
    const isOverdue = isPending && planRow.estado_plan !== 'BAJA' && c.fecha_vencimiento < todayStr;

    if (isPaid) {
      cuotasPagadas += 1;
    } else if (isPending) {
      cuotasPendientes += 1;
      saldoTotalPendiente += c.saldo_pendiente;
      if (!proximaCuota) {
        proximaCuota = { ...c, vencida: isOverdue };
      }
    }
    if (isOverdue) {
      tieneCuotaVencida = true;
    }
    totalAbonado += c.monto_abonado;

    return {
      ...c,
      vencida: isOverdue
    };
  });

  // Determine plan global status & certificate lock rule
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
    movimientos,
    historial,
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

function getPlanById(planId) {
  const todayStr = getTodayDateString();
  const row = db.prepare('SELECT * FROM clientes_planes WHERE id = ?').get(planId);
  return enrichPlan(row, todayStr);
}

function getAllPlans() {
  const todayStr = getTodayDateString();
  const rows = db.prepare('SELECT * FROM clientes_planes ORDER BY id DESC').all();
  return rows.map((r) => enrichPlan(r, todayStr));
}

/**
 * Record payment for a single installment (including completing a Seña or confirming an Alta)
 */
function registrarPagoCuota({
  plan_id,
  cuota_id,
  monto_cobrado,
  cuenta_destino,
  medio_pago = 'TRANSFERENCIA',
  fecha_comprobante,
  observacion = '',
  operadora = 'Cobranzas'
}) {
  if (!cuenta_destino) {
    throw new Error('Debe seleccionar la Cuenta Destino donde ingresó el dinero.');
  }
  if (!fecha_comprobante) {
    throw new Error('Debe ingresar la Fecha real del comprobante de pago.');
  }

  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = db.prepare('SELECT * FROM clientes_planes WHERE id = ?').get(plan_id);
    if (!plan) throw new Error('No se encontró la ficha del cliente.');
    if (plan.estado_plan === 'BAJA') {
      throw new Error('Este plan se encuentra dado de BAJA. Reactívelo primero si desea registrar pagos.');
    }

    const cuota = db.prepare('SELECT * FROM cuotas WHERE id = ? AND plan_id = ?').get(cuota_id, plan_id);
    if (!cuota) throw new Error('No se encontró la cuota seleccionada.');
    if (cuota.estado === 'PAGADA') {
      throw new Error(`La cuota ${cuota.numero_cuota} ya figura como PAGADA.`);
    }

    const montoReal = (monto_cobrado !== undefined && monto_cobrado !== '')
      ? parseFloat(monto_cobrado)
      : cuota.saldo_pendiente;

    if (isNaN(montoReal) || montoReal <= 0) {
      throw new Error('El monto cobrado debe ser mayor a $0.');
    }

    let tipoMovimiento = 'PAGO_CUOTA';
    let detalleMov = `Pago de Cuota ${cuota.numero_cuota} de ${plan.cantidad_cuotas}`;
    let nuevoEstadoModalidad = plan.estado_actual_modalidad;

    if (cuota.numero_cuota === 1 && cuota.estado === 'PARCIAL_SENA') {
      tipoMovimiento = 'SALDO_SENA_CUOTA_1';
      detalleMov = `Saldo restante de Seña (Cuota 1 completada)`;
      nuevoEstadoModalidad = 'PAGO';
    } else if (cuota.numero_cuota === 1 && cuota.estado === 'PENDIENTE_ALTA') {
      tipoMovimiento = 'CONFIRMACION_ALTA_CUOTA_1';
      detalleMov = `Confirmación de Pago de Alta (Cuota 1 abonada)`;
      nuevoEstadoModalidad = 'PAGO';
    }

    const nuevoMontoAbonado = cuota.monto_abonado + montoReal;
    const cuentaFinal = (cuota.cuenta_destino && cuota.cuenta_destino !== cuenta_destino)
      ? `${cuota.cuenta_destino} + ${cuenta_destino}`
      : cuenta_destino;

    const obsFinal = observacion
      ? (cuota.observacion_pago ? `${cuota.observacion_pago} | ${observacion}` : observacion)
      : (cuota.observacion_pago || detalleMov);

    db.prepare(`
      UPDATE cuotas
      SET monto_abonado = ?,
          saldo_pendiente = 0,
          estado = 'PAGADA',
          medio_pago = ?,
          cuenta_destino = ?,
          fecha_comprobante = ?,
          fecha_registro_pago = ?,
          observacion_pago = ?
      WHERE id = ?
    `).run(
      nuevoMontoAbonado,
      medio_pago,
      cuentaFinal,
      fecha_comprobante,
      nowIso,
      obsFinal,
      cuota.id
    );

    const imp = parseYearMonthFromDate(fecha_comprobante, cuota.mes_vencimiento, cuota.anio_vencimiento);
    db.prepare(`
      INSERT INTO movimientos_pago (
        plan_id, cuota_id, numero_cuota, tipo_movimiento, monto,
        cuenta_destino, medio_pago, fecha_comprobante, mes_imputacion, anio_imputacion,
        fecha_registro, operadora, detalle
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      cuota.id,
      cuota.numero_cuota,
      tipoMovimiento,
      montoReal,
      cuenta_destino,
      medio_pago,
      fecha_comprobante,
      imp.mes,
      imp.anio,
      nowIso,
      operadora,
      observacion ? `${detalleMov} (${observacion})` : detalleMov
    );

    // Check if all cuotas are now paid
    const restantes = db.prepare(`
      SELECT COUNT(*) as c FROM cuotas
      WHERE plan_id = ? AND estado != 'PAGADA' AND estado != 'ANULADA_POR_BAJA'
    `).get(plan.id).c;

    const nuevoEstadoPlan = restantes === 0 ? 'COMPLETADO' : 'ACTIVO';

    db.prepare(`
      UPDATE clientes_planes
      SET estado_actual_modalidad = ?,
          estado_plan = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(nuevoEstadoModalidad, nuevoEstadoPlan, nowIso, plan.id);

    db.prepare(`
      INSERT INTO historial_notas (plan_id, texto, autor, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      plan.id,
      `Cobro registrado: Cuota ${cuota.numero_cuota} por $${montoReal.toLocaleString('es-AR')} en ${cuenta_destino} (Comprobante: ${fecha_comprobante}).${observacion ? ' Nota: ' + observacion : ''}`,
      operadora,
      nowIso
    );

    db.exec('COMMIT');
    return getPlanById(plan.id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Advance multiple installments or settle remaining balance (by Transfer or Card Exception)
 */
function adelantarCuotas({
  plan_id,
  cuota_ids,
  monto_total_cobrado,
  medio_pago = 'TRANSFERENCIA', // 'TRANSFERENCIA' or 'TARJETA_ADELANTO'
  cuenta_destino,
  fecha_comprobante,
  observacion = '',
  operadora = 'Cobranzas'
}) {
  if (!Array.isArray(cuota_ids) || cuota_ids.length === 0) {
    throw new Error('Debe seleccionar al menos una cuota pendiente para adelantar/cancelar.');
  }
  if (!fecha_comprobante) {
    throw new Error('Debe indicar la Fecha real del comprobante de pago.');
  }
  const cuentaElegida = medio_pago === 'TARJETA_ADELANTO'
    ? (cuenta_destino || 'Tarjeta (Excepción Adelanto)')
    : cuenta_destino;

  if (!cuentaElegida) {
    throw new Error('Debe seleccionar la Cuenta Destino o Tarjeta.');
  }

  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = db.prepare('SELECT * FROM clientes_planes WHERE id = ?').get(plan_id);
    if (!plan) throw new Error('No se encontró la ficha del cliente.');
    if (plan.estado_plan === 'BAJA') {
      throw new Error('No se pueden adelantar cuotas en un plan dado de BAJA.');
    }

    const placeholders = cuota_ids.map(() => '?').join(',');
    const cuotasSeleccionadas = db.prepare(`
      SELECT * FROM cuotas
      WHERE plan_id = ? AND id IN (${placeholders}) AND estado != 'PAGADA'
      ORDER BY numero_cuota ASC
    `).all(plan_id, ...cuota_ids);

    if (cuotasSeleccionadas.length === 0) {
      throw new Error('Las cuotas seleccionadas ya están pagadas.');
    }

    const sumaSaldos = cuotasSeleccionadas.reduce((acc, c) => acc + c.saldo_pendiente, 0);
    const montoTotal = (monto_total_cobrado !== undefined && monto_total_cobrado !== '')
      ? parseFloat(monto_total_cobrado)
      : sumaSaldos;

    if (isNaN(montoTotal) || montoTotal <= 0) {
      throw new Error('El monto total cobrado debe ser mayor a $0.');
    }

    const factor = sumaSaldos > 0 ? (montoTotal / sumaSaldos) : 1;
    const imp = parseYearMonthFromDate(fecha_comprobante, plan.mes_inicio, plan.anio_inicio);
    const numerosLista = cuotasSeleccionadas.map((c) => c.numero_cuota).join(', ');
    const etiquetaMedio = medio_pago === 'TARJETA_ADELANTO'
      ? 'Cancelación/Adelanto con Tarjeta'
      : `Adelanto por Transferencia (${cuentaElegida})`;

    for (let idx = 0; idx < cuotasSeleccionadas.length; idx++) {
      const c = cuotasSeleccionadas[idx];
      const montoImputado = Math.round(c.saldo_pendiente * factor * 100) / 100;
      const nuevoAbonado = c.monto_abonado + montoImputado;

      db.prepare(`
        UPDATE cuotas
        SET monto_abonado = ?,
            saldo_pendiente = 0,
            estado = 'PAGADA',
            medio_pago = ?,
            cuenta_destino = ?,
            fecha_comprobante = ?,
            fecha_registro_pago = ?,
            observacion_pago = ?
        WHERE id = ?
      `).run(
        nuevoAbonado,
        medio_pago,
        cuentaElegida,
        fecha_comprobante,
        nowIso,
        `${etiquetaMedio}${observacion ? ' - ' + observacion : ''}`,
        c.id
      );
    }

    db.prepare(`
      INSERT INTO movimientos_pago (
        plan_id, cuota_id, numero_cuota, tipo_movimiento, monto,
        cuenta_destino, medio_pago, fecha_comprobante, mes_imputacion, anio_imputacion,
        fecha_registro, operadora, detalle
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      cuotasSeleccionadas[0].id,
      cuotasSeleccionadas[0].numero_cuota,
      medio_pago === 'TARJETA_ADELANTO' ? 'ADELANTO_TARJETA' : 'ADELANTO_TRANSFERENCIA',
      montoTotal,
      cuentaElegida,
      medio_pago === 'TARJETA_ADELANTO' ? 'TARJETA' : 'TRANSFERENCIA',
      fecha_comprobante,
      imp.mes,
      imp.anio,
      nowIso,
      operadora,
      `${etiquetaMedio} - Cuotas N° ${numerosLista}${observacion ? ' (' + observacion + ')' : ''}`
    );

    const restantes = db.prepare(`
      SELECT COUNT(*) as c FROM cuotas
      WHERE plan_id = ? AND estado != 'PAGADA' AND estado != 'ANULADA_POR_BAJA'
    `).get(plan.id).c;

    const nuevoEstadoPlan = restantes === 0 ? 'COMPLETADO' : 'ACTIVO';
    const canceladoTarjeta = medio_pago === 'TARJETA_ADELANTO' ? 1 : plan.cancelado_con_tarjeta;

    db.prepare(`
      UPDATE clientes_planes
      SET estado_actual_modalidad = 'PAGO',
          estado_plan = ?,
          cancelado_con_tarjeta = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(nuevoEstadoPlan, canceladoTarjeta, nowIso, plan.id);

    db.prepare(`
      INSERT INTO historial_notas (plan_id, texto, autor, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      plan.id,
      `${etiquetaMedio}: Cuotas [${numerosLista}] abonadas por un total de $${montoTotal.toLocaleString('es-AR')} (Comprobante: ${fecha_comprobante}).`,
      operadora,
      nowIso
    );

    db.exec('COMMIT');
    return getPlanById(plan.id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Mark a plan as BAJA (annuls unpaid installments, preserves paid installments as valid income, locks certificate)
 */
function darDeBajaPlan({ plan_id, motivo = 'Baja solicitada por el cliente', operadora = 'Cobranzas' }) {
  const nowIso = new Date().toISOString();
  const todayStr = getTodayDateString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = db.prepare('SELECT * FROM clientes_planes WHERE id = ?').get(plan_id);
    if (!plan) throw new Error('No se encontró la ficha del cliente.');

    // Cancel remaining unpaid installments (preserve any already paid monto_abonado!)
    db.prepare(`
      UPDATE cuotas
      SET estado = 'ANULADA_POR_BAJA',
          saldo_pendiente = 0,
          observacion_pago = CASE
            WHEN observacion_pago = '' THEN 'Cuota anulada por baja del plan'
            ELSE observacion_pago || ' | Anulada por baja'
          END
      WHERE plan_id = ? AND estado != 'PAGADA'
    `).run(plan_id);

    db.prepare(`
      UPDATE clientes_planes
      SET estado_plan = 'BAJA',
          motivo_baja = ?,
          fecha_baja = ?,
          notas = CASE WHEN notas = '' THEN ? ELSE notas || ' | BAJA: ' || ? END,
          version = version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(motivo, todayStr, `BAJA: ${motivo}`, motivo, nowIso, plan_id);

    db.prepare(`
      INSERT INTO historial_notas (plan_id, texto, autor, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      plan_id,
      `PLAN DADO DE BAJA. Motivo: ${motivo}. Los pagos previos quedan registrados y el certificado queda bloqueado definitivamente.`,
      operadora,
      nowIso
    );

    db.exec('COMMIT');
    return getPlanById(plan_id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Reactivate a BAJA plan if done by mistake
 */
function reactivarPlan({ plan_id, operadora = 'Cobranzas' }) {
  const nowIso = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = db.prepare('SELECT * FROM clientes_planes WHERE id = ?').get(plan_id);
    if (!plan) throw new Error('No se encontró el plan.');

    const cuotas = db.prepare('SELECT * FROM cuotas WHERE plan_id = ?').all(plan_id);
    for (const c of cuotas) {
      if (c.estado === 'ANULADA_POR_BAJA') {
        const saldoRestaurado = Math.max(0, c.valor_nominal - c.monto_abonado);
        let nuevoEst = 'PENDIENTE';
        if (c.numero_cuota === 1 && c.monto_abonado > 0 && saldoRestaurado > 0) {
          nuevoEst = 'PARCIAL_SENA';
        } else if (c.numero_cuota === 1 && plan.modalidad_inicial === 'ALTA' && c.monto_abonado === 0) {
          nuevoEst = 'PENDIENTE_ALTA';
        }
        db.prepare(`
          UPDATE cuotas
          SET estado = ?, saldo_pendiente = ?
          WHERE id = ?
        `).run(nuevoEst, saldoRestaurado, c.id);
      }
    }

    db.prepare(`
      UPDATE clientes_planes
      SET estado_plan = 'ACTIVO',
          motivo_baja = '',
          fecha_baja = '',
          version = version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(nowIso, plan_id);

    db.prepare(`
      INSERT INTO historial_notas (plan_id, texto, autor, created_at)
      VALUES (?, ?, ?, ?)
    `).run(plan_id, 'Plan reactivado nuevamente.', operadora, nowIso);

    db.exec('COMMIT');
    return getPlanById(plan_id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Update client basic info, notes, or commitment date
 */
function actualizarFichaCliente({
  plan_id,
  dni,
  nombre,
  apellido,
  celular,
  canal,
  vendedora_nombre,
  fecha_compromiso,
  notas,
  operadora = 'Cobranzas'
}) {
  const nowIso = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = db.prepare('SELECT * FROM clientes_planes WHERE id = ?').get(plan_id);
    if (!plan) throw new Error('No se encontró el cliente.');

    const nuevoCanal = canal ? String(canal).toUpperCase() : plan.canal;
    const nuevaVend = nuevoCanal === 'VENDEDORAS'
      ? String(vendedora_nombre !== undefined ? vendedora_nombre : plan.vendedora_nombre).trim()
      : '';

    if (nuevoCanal === 'VENDEDORAS' && !nuevaVend) {
      throw new Error('Si el canal es Vendedoras, es obligatorio indicar el nombre de la vendedora.');
    }

    const nuevaFechaComp = fecha_compromiso !== undefined ? fecha_compromiso : plan.fecha_compromiso;
    const nuevasNotas = notas !== undefined ? String(notas).trim() : plan.notas;

    db.prepare(`
      UPDATE clientes_planes
      SET dni = ?,
          nombre = ?,
          apellido = ?,
          celular = ?,
          canal = ?,
          vendedora_nombre = ?,
          fecha_compromiso = ?,
          notas = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(
      dni !== undefined ? String(dni).trim() : plan.dni,
      nombre !== undefined ? String(nombre).trim() : plan.nombre,
      apellido !== undefined ? String(apellido).trim() : plan.apellido,
      celular !== undefined ? String(celular).trim() : plan.celular,
      nuevoCanal,
      nuevaVend,
      nuevaFechaComp,
      nuevasNotas,
      nowIso,
      plan_id
    );

    // If Cuota 1 is still PARCIAL_SENA or PENDIENTE_ALTA and fecha_compromiso changed, sync Cuota 1 due date
    if (fecha_compromiso && fecha_compromiso !== plan.fecha_compromiso) {
      db.prepare(`
        UPDATE cuotas
        SET fecha_vencimiento = ?
        WHERE plan_id = ? AND numero_cuota = 1 AND estado IN ('PARCIAL_SENA', 'PENDIENTE_ALTA')
      `).run(fecha_compromiso, plan_id);
    }

    if (notas !== undefined && nuevasNotas !== plan.notas && nuevasNotas) {
      db.prepare(`
        INSERT INTO historial_notas (plan_id, texto, autor, created_at)
        VALUES (?, ?, ?, ?)
      `).run(plan_id, `Nota actualizada: "${nuevasNotas}"`, operadora, nowIso);
    }

    db.exec('COMMIT');
    return getPlanById(plan_id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function agregarNotaSeguimiento({ plan_id, texto, actualizar_recordatorio = true, operadora = 'Cobranzas' }) {
  if (!texto || !String(texto).trim()) {
    throw new Error('Escriba el texto de la nota de seguimiento.');
  }
  const cleanText = String(texto).trim();
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO historial_notas (plan_id, texto, autor, created_at)
      VALUES (?, ?, ?, ?)
    `).run(plan_id, cleanText, operadora, nowIso);

    if (actualizar_recordatorio) {
      db.prepare(`
        UPDATE clientes_planes
        SET notas = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(cleanText, nowIso, plan_id);
    }

    db.exec('COMMIT');
    return getPlanById(plan_id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Seed realistic continuous data from Enero 2025 through Hoy (13/11/2026)
 */
function seedInitialPlans() {
  const payRest = (plan, countToPay, cuentaDefault, dayOfMonth = 8) => {
    const pendientes = plan.cuotas.filter((c) => c.estado !== 'PAGADA');
    const slice = countToPay === 'ALL' ? pendientes : pendientes.slice(0, countToPay);
    for (const c of slice) {
      const fComp = buildDateStr(c.anio_vencimiento, c.mes_vencimiento, dayOfMonth);
      registrarPagoCuota({
        plan_id: plan.id,
        cuota_id: c.id,
        monto_cobrado: c.saldo_pendiente,
        cuenta_destino: cuentaDefault,
        fecha_comprobante: fComp,
        observacion: 'Transferencia verificada por cobranzas',
        operadora: 'Marta (Cobranzas)'
      });
    }
  };

  // =========================================================================
  // AÑO 2025 (ENERO A DICIEMBRE 2025) - HISTÓRICO CONTINUO
  // =========================================================================
  const historicos2025 = [
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

  for (const h of historicos2025) {
    const p = createPlan({
      dni: h.dni,
      nombre: h.nombre,
      apellido: h.apellido,
      celular: h.cel,
      canal: h.canal,
      vendedora_nombre: h.vend || '',
      modalidad_inicial: 'PAGO',
      cantidad_cuotas: h.cuotas,
      valor_cuota_base: h.valor,
      mes_inicio: h.mes,
      anio_inicio: 2025,
      dia_vencimiento: 10,
      cuenta_destino_inicial: h.cuenta,
      fecha_comprobante_inicial: buildDateStr(2025, h.mes, h.dia),
      notas: `Plan iniciado en ${h.mes}/2025.`,
      operadora: 'Administración'
    });

    if (h.status === 'COMPLETADO') {
      payRest(p, 'ALL', h.cuenta, h.dia);
    } else if (h.status === 'ADELANTO_TARJETA') {
      payRest(p, 1, h.cuenta, h.dia);
      const refreshed = getPlanById(p.id);
      const restIds = refreshed.cuotas.filter((c) => c.estado !== 'PAGADA').map((c) => c.id);
      adelantarCuotas({
        plan_id: p.id,
        cuota_ids: restIds,
        monto_total_cobrado: restIds.length * h.valor,
        medio_pago: 'TARJETA_ADELANTO',
        cuenta_destino: 'Tarjeta (Excepción Adelanto)',
        fecha_comprobante: buildDateStr(2025, 8, 14),
        observacion: 'Adelantó saldo restante con tarjeta en 2025 para certificación',
        operadora: 'Marta (Cobranzas)'
      });
    } else if (h.status === 'BAJA_C2') {
      darDeBajaPlan({
        plan_id: p.id,
        motivo: 'Solicitó baja en 2025 tras abonar cuota 1. Ingreso conservado.',
        operadora: 'Claudia (Cobranzas)'
      });
    } else if (h.status === 'DEUDOR_2025') {
      // Paid 9 of 12 installments, owes last 3 (Sep, Oct, Nov 2026)
      payRest(p, 8, h.cuenta, 9);
    }
  }

  // =========================================================================
  // AÑO 2026 (ENERO A OCTUBRE 2026)
  // =========================================================================
  const historicos2026 = [
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

  for (const h of historicos2026) {
    const p = createPlan({
      dni: h.dni,
      nombre: h.nombre,
      apellido: h.apellido,
      celular: h.cel,
      canal: h.canal,
      vendedora_nombre: h.vend || '',
      modalidad_inicial: 'PAGO',
      cantidad_cuotas: h.cuotas,
      valor_cuota_base: h.valor,
      mes_inicio: h.mes,
      anio_inicio: 2026,
      dia_vencimiento: 10,
      cuenta_destino_inicial: h.cuenta,
      fecha_comprobante_inicial: buildDateStr(2026, h.mes, 7),
      notas: `Plan iniciado en ${h.mes}/2026.`,
      operadora: 'Administración'
    });

    if (h.status === 'COMPLETADO') {
      payRest(p, 'ALL', h.cuenta, 8);
    } else if (h.status === 'AL_DIA_NOV_PAGADA') {
      // Pay up to Noviembre 2026
      const toPay = p.cuotas.filter(
        (c) => c.estado !== 'PAGADA' && (c.anio_vencimiento === 2026 && c.mes_vencimiento <= 11)
      );
      for (const c of toPay) {
        registrarPagoCuota({
          plan_id: p.id,
          cuota_id: c.id,
          monto_cobrado: c.saldo_pendiente,
          cuenta_destino: h.cuenta,
          fecha_comprobante: buildDateStr(c.anio_vencimiento, c.mes_vencimiento, 9),
          observacion: 'Cuota abonada en término',
          operadora: 'Marta (Cobranzas)'
        });
      }
    } else if (h.status === 'DEUDOR_OCT_NOV') {
      // Paid Sep, owes Oct and Nov 2026
    }
  }

  // =========================================================================
  // CASOS CLAVE DE OCTUBRE / NOVIEMBRE 2026 Y VENTAS CARGADAS HOY (13/11/2026)
  // =========================================================================

  // 1. Cristina Gómez - Seña (Mismo mes) - Vendedoras (Laura Martínez) - Compromiso 20/11/2026
  createPlan({
    dni: '34567890',
    nombre: 'Cristina',
    apellido: 'Gómez',
    celular: '11 5432-8910',
    canal: 'VENDEDORAS',
    vendedora_nombre: 'Laura Martínez',
    modalidad_inicial: 'SENA_MISMO_MES',
    cantidad_cuotas: 3,
    valor_cuota_base: 50000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Mercado Pago',
    fecha_comprobante_inicial: '2026-11-05',
    monto_sena: 20000,
    fecha_compromiso: '2026-11-20',
    notas: 'Abona restante de $30.000 el 20/11 cuando cobra incentivo docente.',
    operadora: 'Administración'
  });

  // 2. Roberto Carlos Fernández - Deudor Atrasado (Cuota 2 vencida el 10/11/2026) - Canal Sebastián
  createPlan({
    dni: '28940112',
    nombre: 'Roberto Carlos',
    apellido: 'Fernández',
    celular: '11 6789-4321',
    canal: 'SEBASTIAN',
    modalidad_inicial: 'PAGO',
    cantidad_cuotas: 3,
    valor_cuota_base: 45000,
    mes_inicio: 10,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-10-08',
    notas: 'Venció cuota 2 el 10/11. Prometió transferir el viernes por la tarde.',
    operadora: 'Administración'
  });

  // 3. María Elena Quiroga - Alta (Pago diferido) - Canal Tramos - Comprometió pago 18/11/2026
  createPlan({
    dni: '31209844',
    nombre: 'María Elena',
    apellido: 'Quiroga',
    celular: '351 612-9087',
    canal: 'TRAMOS',
    modalidad_inicial: 'ALTA',
    cantidad_cuotas: 4,
    valor_cuota_base: 55000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    fecha_compromiso: '2026-11-18',
    notas: 'Alta sin seña. Prometió abonar la Cuota 1 completa el 18/11 por transferencia.',
    operadora: 'Administración'
  });

  // 4. Graciela Beatriz Pereyra - Seña Mes Siguiente - Vendedoras (Carolina Gómez)
  createPlan({
    dni: '26410982',
    nombre: 'Graciela Beatriz',
    apellido: 'Pereyra',
    celular: '221 598-3341',
    canal: 'VENDEDORAS',
    vendedora_nombre: 'Carolina Gómez',
    modalidad_inicial: 'SENA_MES_SIGUIENTE',
    cantidad_cuotas: 3,
    valor_cuota_base: 50000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Xise',
    fecha_comprobante_inicial: '2026-11-11',
    monto_sena: 15000,
    fecha_compromiso: '2026-12-08',
    notas: 'Dejó seña de $15.000. Completa los $35.000 restantes de Cuota 1 el 08/12.',
    operadora: 'Administración'
  });

  // 5. Héctor Daniel Morales - Pago (Cuota 1 abonada en Noviembre, al día, en curso) - Canal Sebastián
  createPlan({
    dni: '29876543',
    nombre: 'Héctor Daniel',
    apellido: 'Morales',
    celular: '11 4390-1122',
    canal: 'SEBASTIAN',
    modalidad_inicial: 'PAGO',
    cantidad_cuotas: 3,
    valor_cuota_base: 50000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Adriana',
    fecha_comprobante_inicial: '2026-11-09',
    notas: 'Cuota 1 al día. Próximo vencimiento en Diciembre.',
    operadora: 'Administración'
  });

  // 6. Patricia Susana Ledesma - Plan 100% Completado (Adelantó saldo con Tarjeta) - Tramos
  const planPatricia = createPlan({
    dni: '24551239',
    nombre: 'Patricia Susana',
    apellido: 'Ledesma',
    celular: '341 587-6612',
    canal: 'TRAMOS',
    modalidad_inicial: 'PAGO',
    cantidad_cuotas: 3,
    valor_cuota_base: 48000,
    mes_inicio: 9,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-09-07',
    notas: 'Necesitaba urgente la certificación para presentar en junta.',
    operadora: 'Administración'
  });
  const cuotasPendPatricia = planPatricia.cuotas.filter((c) => c.estado !== 'PAGADA').map((c) => c.id);
  adelantarCuotas({
    plan_id: planPatricia.id,
    cuota_ids: cuotasPendPatricia,
    monto_total_cobrado: 96000,
    medio_pago: 'TARJETA_ADELANTO',
    cuenta_destino: 'Tarjeta (Excepción Adelanto)',
    fecha_comprobante: '2026-11-04',
    observacion: 'Canceló cuotas 2 y 3 con tarjeta para liberar certificado de inmediato',
    operadora: 'Marta (Cobranzas)'
  });

  // 7. Silvia Noemí Castro - Cuota 2 pendiente en Noviembre (vence 25/11) - Vendedoras (Valeria Díaz)
  createPlan({
    dni: '30998123',
    nombre: 'Silvia Noemí',
    apellido: 'Castro',
    celular: '11 3210-9988',
    canal: 'VENDEDORAS',
    vendedora_nombre: 'Valeria Díaz',
    modalidad_inicial: 'PAGO',
    cantidad_cuotas: 3,
    valor_cuota_base: 50000,
    mes_inicio: 10,
    anio_inicio: 2026,
    dia_vencimiento: 25,
    cuenta_destino_inicial: 'Mercado Pago',
    fecha_comprobante_inicial: '2026-10-20',
    notas: 'Cobra haberes el día 22, vence el 25/11.',
    operadora: 'Administración'
  });

  // 8. Jorge Luis Domínguez - Dado de BAJA a mitad de plan - Canal Sebastián
  const planJorge = createPlan({
    dni: '22765109',
    nombre: 'Jorge Luis',
    apellido: 'Domínguez',
    celular: '261 490-8877',
    canal: 'SEBASTIAN',
    modalidad_inicial: 'PAGO',
    cantidad_cuotas: 3,
    valor_cuota_base: 45000,
    mes_inicio: 10,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-10-06',
    notas: 'Pagó cuota 1 en octubre y solicitó baja en noviembre.',
    operadora: 'Administración'
  });
  darDeBajaPlan({
    plan_id: planJorge.id,
    motivo: 'Abandonó la cursada en cuota 2. Cuota 1 queda registrada como ingreso válido.',
    operadora: 'Marta (Cobranzas)'
  });

  // 9. Norma Beatriz Villalba - Seña mismo mes vencida (comprometió 11/11) - Tramos
  createPlan({
    dni: '27654321',
    nombre: 'Norma Beatriz',
    apellido: 'Villalba',
    celular: '11 5098-7123',
    canal: 'TRAMOS',
    modalidad_inicial: 'SENA_MISMO_MES',
    cantidad_cuotas: 3,
    valor_cuota_base: 50000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Adriana',
    fecha_comprobante_inicial: '2026-11-02',
    monto_sena: 25000,
    fecha_compromiso: '2026-11-11',
    notas: 'Debía completar los $25.000 restantes el 11/11. Reclamar por WhatsApp hoy.',
    operadora: 'Administración'
  });

  // =========================================================================
  // VENTAS CARGADAS HOY MISMO (13/11/2026) PARA SIMULAR OPERACIÓN DEL DÍA
  // =========================================================================

  // 10. Cargada HOY 13/11/2026 - Pago Cuota 1 - Sebastián
  createPlan({
    dni: '35123456',
    nombre: 'Luciana Paola',
    apellido: 'Giménez',
    celular: '11 6890-1144',
    canal: 'SEBASTIAN',
    modalidad_inicial: 'PAGO',
    cantidad_cuotas: 3,
    valor_cuota_base: 52000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Openpay',
    fecha_comprobante_inicial: '2026-11-13',
    notas: 'Cargada hoy 13/11. Envió comprobante de Cuota 1 por Openpay.',
    operadora: 'Administración (Ventas)'
  });

  // 11. Cargada HOY 13/11/2026 - Seña mismo mes - Vendedoras (Romina Sosa)
  createPlan({
    dni: '33789012',
    nombre: 'Valeria Alejandra',
    apellido: 'Morán',
    celular: '351 645-8899',
    canal: 'VENDEDORAS',
    vendedora_nombre: 'Romina Sosa',
    modalidad_inicial: 'SENA_MISMO_MES',
    cantidad_cuotas: 4,
    valor_cuota_base: 52000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Mercado Pago',
    fecha_comprobante_inicial: '2026-11-13',
    monto_sena: 22000,
    fecha_compromiso: '2026-11-24',
    notas: 'Cargada hoy 13/11. Seña $22.000, completa los $30.000 el 24/11.',
    operadora: 'Administración (Ventas)'
  });

  // 12. Cargada HOY 13/11/2026 - Alta diferida - Tramos
  createPlan({
    dni: '29456781',
    nombre: 'Fernando Javier',
    apellido: 'Almada',
    celular: '221 511-2233',
    canal: 'TRAMOS',
    modalidad_inicial: 'ALTA',
    cantidad_cuotas: 3,
    valor_cuota_base: 55000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    fecha_compromiso: '2026-11-21',
    notas: 'Cargada hoy 13/11. Alta diferida, transfiere Cuota 1 el 21/11.',
    operadora: 'Administración (Ventas)'
  });

  // 13. Cargada HOY 13/11/2026 - Seña mes siguiente - Vendedoras (Laura Martínez)
  createPlan({
    dni: '32890123',
    nombre: 'Gabriela Fernanda',
    apellido: 'Roldán',
    celular: '11 5345-6677',
    canal: 'VENDEDORAS',
    vendedora_nombre: 'Laura Martínez',
    modalidad_inicial: 'SENA_MES_SIGUIENTE',
    cantidad_cuotas: 3,
    valor_cuota_base: 52000,
    mes_inicio: 11,
    anio_inicio: 2026,
    dia_vencimiento: 10,
    cuenta_destino_inicial: 'Xise',
    fecha_comprobante_inicial: '2026-11-13',
    monto_sena: 17000,
    fecha_compromiso: '2026-12-05',
    notas: 'Cargada hoy 13/11. Seña $17.000, abona saldo de $35.000 el 05/12.',
    operadora: 'Administración (Ventas)'
  });
}

ensureInitialized();

module.exports = {
  db,
  getConfigMap,
  setConfigValue,
  getAllPlans,
  getPlanById,
  createPlan,
  registrarPagoCuota,
  adelantarCuotas,
  darDeBajaPlan,
  reactivarPlan,
  actualizarFichaCliente,
  agregarNotaSeguimiento,
  getTodayDateString
};

import { createHash } from "node:crypto";
import {
  Aprobacion,
  CentroCosto,
  CentroCostoSchema,
  CondicionPagoSchema,
  Cotizacion,
  CotizacionSchema,
  Factura,
  FacturaSchema,
  Hallazgo,
  IndicadorIvaSchema,
  Maestros,
  OrdenCompra,
  OrdenCompraSchema,
  Paquete,
  Proveedor,
  ProveedorSchema,
  Solicitud,
  Validacion,
} from "./types.js";
import {
  compareDates,
  normalizeName,
  normalizeNit,
  parseSapAmount,
  readJson,
  safeJoin,
  toDateOnly,
} from "./lib/paths.js";

/**
 * Reglas de negocio puras del proceso de órdenes de compra (sección 7.3 del PRD).
 *
 * Diseño: TODO lo determinista vive aquí, sin HTTP, sin LLM y sin estado.
 *  - demo.ts lo ejecuta directamente (determinismo demostrable).
 *  - Las herramientas (src/tools/oc.ts) solo envuelven estas funciones con
 *    validación zod de argumentos y registro en la bitácora.
 *  - Un cambio en las reglas de control RC1–RC10 toca SOLO este archivo.
 *
 * Seguridad: estas funciones son la fuente única de valores (CA2 del PRD).
 * El modelo LLM nunca decide si una OC es apta: solo propone y pregunta.
 */

// ---------------------------------------------------------------------------
// Carga de maestros
// ---------------------------------------------------------------------------

export async function loadMaestros(directory: string): Promise<Maestros> {
  const base = safeJoin(directory, "fixtures", "reto-03", "maestros");
  const proveedores = ProveedorSchema.array().parse(await readJson<unknown>(safeJoin(base, "proveedores.json")));
  const centrosCosto = CentroCostoSchema.array().parse(await readJson<unknown>(safeJoin(base, "centros-costo.json")));
  const indicadoresIva = IndicadorIvaSchema.array().parse(await readJson<unknown>(safeJoin(base, "indicadores-iva.json")));
  const condicionesPago = CondicionPagoSchema.array().parse(await readJson<unknown>(safeJoin(base, "condiciones-pago.json")));
  return { proveedores, centrosCosto, indicadoresIva, condicionesPago };
}

// ---------------------------------------------------------------------------
// Parseo determinista de adjuntos de texto
// ---------------------------------------------------------------------------

/**
 * Extrae los datos de la cotización desde su texto plano.
 * Regex acotadas a los encabezados del formato de fixture: el objetivo es
 * determinismo total, no entender texto libre arbitrario (eso sería trabajo
 * del modelo enriqueciendo, pero el valor que se registra sale de aquí).
 */
export function parseCotizacion(texto: string): Cotizacion | null {
  if (!texto.trim()) return null;
  const numero = /^COTIZACIÓN\s+(.+)$/m.exec(texto)?.[1]?.trim() ?? "";
  const fecha = /^Fecha:\s*(\d{4}-\d{2}-\d{2})$/m.exec(texto)?.[1] ?? null;
  const proveedor = /^Proveedor:\s*(.+)$/m.exec(texto)?.[1]?.trim() ?? "";
  const nitLine = /^NIT:\s*(.+)$/m.exec(texto)?.[1]?.trim() ?? null;
  // El NIT del fixture trae formato "900.555.111-2": la parte antes del guión
  // es el identificador y la última cifra es el dígito de verificación, que el
  // maestro almacena por separado (PRD 7.2: sin DV ni puntos).
  const nitSinDv = nitLine ? normalizeNit(nitLine.split("-")[0] ?? "") : null;
  const totalMatch = /^TOTAL \(IVA incluido\):\s*(COP|USD)\s*([\d.,]+)$/m.exec(texto);
  const moneda = (totalMatch?.[1] as "COP" | "USD" | undefined) ?? "";
  const total = totalMatch?.[2] != null ? parseSapAmount(totalMatch[2]) : NaN;
  const validezDias = /^Validez de la oferta:\s*(\d+) días?$/m.exec(texto)?.[1];

  let validez_hasta: string | null = null;
  if (fecha && validezDias) {
    const d = new Date(fecha + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + Number(validezDias));
    validez_hasta = d.toISOString().slice(0, 10);
  }

  const parsed = CotizacionSchema.safeParse({
    numero,
    fecha,
    proveedor,
    nit: nitSinDv,
    total,
    moneda,
    validez_hasta,
    texto,
  });
  return parsed.success ? parsed.data : null;
}

export function parseFactura(texto: string): Factura | null {
  if (!texto.trim()) return null;
  const numero = /No\.?\s*([A-Z0-9-]+)/i.exec(texto)?.[1]?.trim() ?? "";
  const fecha = /Fecha de emisión:\s*(\d{4}-\d{2}-\d{2})/.exec(texto)?.[1] ?? "";
  const totalMatch = /^TOTAL:\s*(?:COP\s+|USD\s+)?([\d.,]+)$/m.exec(texto);
  const total = totalMatch?.[1] != null ? parseSapAmount(totalMatch[1]) : NaN;
  const parsed = FacturaSchema.safeParse({ numero, fecha, total });
  return parsed.success && numero && fecha ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Matriz de controles RC1–RC10 (sección 7.3 del PRD)
// ---------------------------------------------------------------------------

/** Busca el proveedor en el maestro: primero por NIT, luego por nombre. */
export function resolverProveedor(sol: Solicitud, maestros: Maestros): Proveedor | null {
  if (sol.proveedor_nit) {
    const nit = normalizeNit(sol.proveedor_nit);
    const porNit = maestros.proveedores.find((p) => normalizeNit(p.nit) === nit);
    if (porNit) return porNit;
  }
  const nombre = normalizeName(sol.proveedor_nombre);
  return maestros.proveedores.find((p) => normalizeName(p.nombre) === nombre) ?? null;
}

export function resolverCentro(sol: Solicitud, maestros: Maestros): CentroCosto | null {
  return maestros.centrosCosto.find((c) => c.centro_costo === sol.centro_costo) ?? null;
}

/**
 * Aplica las 10 reglas de control al paquete.
 *
 *  - bloqueos: impiden crear la OC (el agente devuelve la razón y la acción sugerida).
 *  - confirmaciones: permiten crear SOLO con confirmación humana explícita.
 *  - derivados: valores completados desde maestros; se informan al usuario.
 *  - retroactiva: la factura llegó antes que la solicitud (desvío de proceso).
 */
export function validarPaquete(paquete: Paquete, maestros: Maestros): Validacion {
  const bloqueos: Hallazgo[] = [];
  const confirmaciones: Hallazgo[] = [];
  const derivados: Validacion["derivados"] = {};
  const sol = paquete.solicitud;
  let retroactiva = false;

  const proveedor = resolverProveedor(sol, maestros);
  const centro = resolverCentro(sol, maestros);
  const aprobacion = paquete.aprobacion;
  const cotizacion = paquete.cotizacion;

  // RC10 — coherencia aritmética: cantidad × valor_unitario ≈ valor_total (±1)
  const esperado = sol.cantidad * sol.valor_unitario;
  if (Math.abs(esperado - sol.valor_total) > 1) {
    bloqueos.push({
      codigo: "RC10",
      tipo: "bloqueo",
      detalle: `cantidad×valor_unitario (${esperado}) no cuadra con valor_total (${sol.valor_total}). Pedir al solicitante una solicitud corregida.`,
    });
  }

  // RC1 — proveedor existe y está activo
  if (!proveedor) {
    bloqueos.push({
      codigo: "RC1",
      tipo: "bloqueo",
      detalle: `El proveedor "${sol.proveedor_nombre}" (NIT ${sol.proveedor_nit ?? "sin NIT"}) no existe en el maestro. Sugerencia: alta de proveedor en SAP antes de crear la OC.`,
    });
  } else if (!proveedor.activo) {
    bloqueos.push({
      codigo: "RC1",
      tipo: "bloqueo",
      detalle: `El proveedor ${proveedor.nombre} (código SAP ${proveedor.codigo_sap}) está inactivo. Sugerencia: reactivar o seleccionar otro proveedor.`,
    });
  }

  // RC4 — la subárea pertenece al centro de costo
  if (!centro) {
    bloqueos.push({
      codigo: "RC4",
      tipo: "bloqueo",
      detalle: `El centro de costo ${sol.centro_costo} no existe en el maestro. Sugerencia: confirmar la codificación con contabilidad.`,
    });
  } else if (!centro.subareas.includes(sol.subarea)) {
    bloqueos.push({
      codigo: "RC4",
      tipo: "bloqueo",
      detalle: `La subárea "${sol.subarea}" no pertenece al centro de costo ${sol.centro_costo} (${centro.subareas.join(", ")}). Sugerencia: corregir la solicitud.`,
    });
  }

  // RC2 — aprobación existe, dice "Aprobado" y viene de un aprobador del centro
  let aprobadorDelCentro: { email: string; nombre: string; tope: number } | null = null;
  if (!aprobacion) {
    bloqueos.push({
      codigo: "RC2",
      tipo: "bloqueo",
      detalle: "No se recibió correo de aprobación del líder. Sugerencia: solicitar la aprobación por correo al aprobador del centro de costo.",
    });
  } else if (!aprobacion.aprobado) {
    bloqueos.push({
      codigo: "RC2",
      tipo: "bloqueo",
      detalle: "El correo del líder no contiene una aprobación explícita. Sugerencia: pedir confirmación escrita.",
    });
  } else if (centro) {
    aprobadorDelCentro =
      centro.aprobadores.find((a) => a.email.toLowerCase() === aprobacion.de.toLowerCase()) ?? null;
    if (!aprobadorDelCentro) {
      bloqueos.push({
        codigo: "RC2",
        tipo: "bloqueo",
        detalle: `${aprobacion.de} no es aprobador del centro de costo ${sol.centro_costo}. Sugerencia: escalar a un aprobador autorizado del centro.`,
      });
    }
  }

  // RC3 — el aprobador tiene tope suficiente para el monto
  if (aprobadorDelCentro && sol.valor_total > aprobadorDelCentro.tope) {
    bloqueos.push({
      codigo: "RC3",
      tipo: "bloqueo",
      detalle: `El valor ${sol.valor_total} supera el tope de ${aprobadorDelCentro.email} (${aprobadorDelCentro.tope}) para ${sol.centro_costo}. Sugerencia: aprobación de un líder con mayor tope.`,
    });
  }

  // RC5 — cotización: existe y cuadra con la solicitud (±2 %)
  if (!cotizacion) {
    confirmaciones.push({
      codigo: "RC5",
      tipo: "confirmacion",
      detalle: "No se recibió cotización del proveedor. Confirmar que la compra procede sin cotización.",
    });
  } else {
    if (sol.valor_total > 0) {
      const diff = Math.abs(cotizacion.total - sol.valor_total) / sol.valor_total;
      if (diff > 0.02) {
        confirmaciones.push({
          codigo: "RC5",
          tipo: "confirmacion",
          detalle: `La cotización ${cotizacion.numero} totaliza ${cotizacion.total}, distinto a la solicitud (${sol.valor_total}, desviación ${(diff * 100).toFixed(1)}%). Confirmar con cuál valor crear la OC.`,
        });
      }
    }
    // Control extra de consistencia: el NIT de la cotización debe ser el del proveedor.
    if (proveedor && cotizacion.nit && normalizeNit(proveedor.nit) !== cotizacion.nit) {
      confirmaciones.push({
        codigo: "RC5",
        tipo: "confirmacion",
        detalle: `El NIT de la cotización (${cotizacion.nit}) no coincide con el del proveedor (${proveedor.nit}). Confirmar que la cotización corresponde al proveedor.`,
      });
    }
  }

  // RC6 / RC7 — derivaciones desde el maestro de proveedores
  if (proveedor) {
    if (!sol.indicador_iva) {
      derivados["indicador_iva"] = { valor: proveedor.indicador_iva_default, fuente: `maestro.proveedores.${proveedor.codigo_sap}.indicador_iva_default` };
      confirmaciones.push({
        codigo: "RC6",
        tipo: "confirmacion",
        detalle: `La solicitud no trae indicador de IVA; se propone el del proveedor (${proveedor.indicador_iva_default}). Confirmar para crear la OC.`,
      });
    }
    if (!sol.condiciones_pago) {
      derivados["condiciones_pago"] = { valor: proveedor.condiciones_pago_default, fuente: `maestro.proveedores.${proveedor.codigo_sap}.condiciones_pago_default` };
      // RC7 solo se informa: no requiere confirmación.
    }
  }

  // RC8 — compra retroactiva: la factura existe y es anterior a la solicitud
  if (paquete.factura && compareDates(paquete.factura.fecha, sol.fecha_solicitud) < 0) {
    retroactiva = true;
    confirmaciones.push({
      codigo: "RC8",
      tipo: "confirmacion",
      detalle: `La factura ${paquete.factura.numero} (${paquete.factura.fecha}) es anterior a la solicitud (${sol.fecha_solicitud}): OC retroactiva. Confirmar creación; quedará marcada para medición del desvío.`,
    });
  }

  // RC9 — la aprobación no es anterior a la solicitud
  if (aprobacion && compareDates(toDateOnly(aprobacion.fecha), sol.fecha_solicitud) < 0) {
    confirmaciones.push({
      codigo: "RC9",
      tipo: "confirmacion",
      detalle: `La aprobación (${toDateOnly(aprobacion.fecha)}) es anterior a la solicitud (${sol.fecha_solicitud}). Confirmar que la aprobación cubre esta compra.`,
    });
  }

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva };
}

// ---------------------------------------------------------------------------
// Evidencia de aprobación (HU-4)
// ---------------------------------------------------------------------------

/** Cuerpo canónico de la evidencia (sin la línea de hash). */
export function buildEvidenceBody(aprobacion: Aprobacion & { aprobado: boolean }): string {
  return [
    "EVIDENCIA DE APROBACIÓN — ANEXO DE ORDEN DE COMPRA",
    "=".repeat(60),
    `De:       ${aprobacion.de}`,
    `Para:     ${aprobacion.para ?? "(no informado)"}`,
    `Fecha:    ${aprobacion.fecha}`,
    `Asunto:   ${aprobacion.asunto}`,
    `Veredicto: ${aprobacion.aprobado ? "APROBADO" : "NO APROBADO"}`,
    "-".repeat(60),
    aprobacion.cuerpo,
  ].join("\n");
}

/** Contenido canónico del archivo de evidencia: cuerpo + línea con sha256. */
export function buildEvidenceContent(aprobacion: Aprobacion & { aprobado: boolean }): string {
  const body = buildEvidenceBody(aprobacion);
  const hash = sha256(body + "\n");
  return `${body}\n${"-".repeat(60)}\nsha256: ${hash}\n`;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Construcción del payload de la OC (HU-3, sección 7.4 del PRD)
// ---------------------------------------------------------------------------

/** Unidad de medida inferida de la descripción (heurística determinista). */
export function inferirUnidad(descripcion: string): "UN" | "H" | "MES" {
  const d = normalizeName(descripcion);
  if (/\bhora/.test(d)) return "H"; // bolsa de horas, servicios por hora
  if (/\b(licencia|anual|mes|ano|vigencia)\b/.test(d)) return "MES";
  return "UN";
}

/**
 * Arma el payload OrdenCompra completo y la tabla de trazabilidad campo→fuente.
 * Todos los valores salen del paquete, de los maestros o de los derivados
 * aprobados: el modelo LLM no puede alterar este objeto (CA2).
 */
export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  maestros: Maestros,
  evidenciaSha: string
): { orden: OrdenCompra; trazabilidad: Record<string, string> } {
  const sol = paquete.solicitud;
  const proveedor = resolverProveedor(sol, maestros);
  if (!proveedor) throw new Error("RC1: proveedor no resoluble; no se puede construir payload");

  const indicadorIva = sol.indicador_iva ?? validacion.derivados["indicador_iva"]?.valor;
  const condicionesPago = sol.condiciones_pago ?? validacion.derivados["condiciones_pago"]?.valor;
  if (!indicadorIva || !condicionesPago) {
    throw new Error("Payload incompleto: faltan indicador_iva o condiciones_pago");
  }
  const aprobacion = paquete.aprobacion;
  if (!aprobacion) throw new Error("Payload incompleto: sin aprobación");

  const trazabilidad: Record<string, string> = {
    "proveedor.codigo_sap": `maestro.proveedores.${proveedor.codigo_sap}`,
    "proveedor.nit": "solicitud.proveedor_nit",
    "proveedor.nombre": "solicitud.proveedor_nombre",
    moneda: "solicitud.moneda",
    condiciones_pago: sol.condiciones_pago
      ? "solicitud.condiciones_pago"
      : validacion.derivados["condiciones_pago"]!.fuente,
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "oc_generar_evidencia",
    "posiciones[0].descripcion": "solicitud.descripcion (texto breve ≤ 40)",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": sol.indicador_iva
      ? "solicitud.indicador_iva"
      : validacion.derivados["indicador_iva"]!.fuente,
    "referencia.cotizacion_ref": paquete.cotizacion ? "cotizacion.numero" : "(sin cotización)",
  };

  const orden: OrdenCompra = {
    referencia: {
      solicitud_id: sol.solicitud_id,
      correo_id: paquete.correo.id,
      cotizacion_ref: paquete.cotizacion?.numero ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: proveedor.codigo_sap,
      nit: normalizeNit(proveedor.nit),
      nombre: proveedor.nombre,
    },
    moneda: sol.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: aprobacion.de,
      fecha_aprobacion: aprobacion.fecha,
      evidencia_sha256: evidenciaSha,
    },
    posiciones: [
      {
        numero: 10, // numeración SAP: 10, 20, 30...
        descripcion: sol.descripcion.slice(0, 40), // límite de texto breve SAP
        cantidad: sol.cantidad,
        unidad: inferirUnidad(sol.descripcion),
        precio_unitario: sol.valor_unitario,
        centro_costo: sol.centro_costo,
        subarea: sol.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({
      codigo: c.codigo,
      detalle: c.detalle,
      confirmado_por: null, // se completa al crear con confirmación humana
    })),
  };

  // Última línea de defensa (OWASP LLM05): el payload se valida contra su
  // esquema zod antes de salir de la capa de reglas.
  return { orden: OrdenCompraSchema.parse(orden), trazabilidad };
}

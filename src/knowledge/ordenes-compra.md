# Conocimiento del proceso — Órdenes de compra en P_ITG

> Este archivo es el conocimiento de dominio que el agente puede consultar.
> Vive en `src/knowledge/` separado del comportamiento (`agent/prompt.md`)
> y de la ejecución (`src/tools/`): un cambio de reglas de negocio no debe
> tocar el servidor.

## Flujo as-is (antes del agente)

1. El solicitante envía por correo: solicitud (Excel), cotización del proveedor (PDF) y correo de aprobación del líder.
2. La analista digita a mano en SAP GUI: proveedor, descripción, centro de costo, subárea, valor, indicador de IVA, aprobador y condiciones de pago.
3. El correo de aprobación se imprime a PDF y se adjunta a la OC como evidencia.
4. Frecuencia: una OC por cada factura que ingresa.

## Dolor

- Digitación repetitiva con alto costo de error (un centro de costo mal digitado se corrige en cierre).
- La verificación "¿este aprobador puede aprobar este monto en este centro?" es mental, no sistemática.
- Desvío conocido: muchas OC se crean **después** de recibida la factura, saltándose la cotización. Nadie mide qué porcentaje.

## Controles que aplica el agente (matriz RC1–RC10)

| Código | Control | Efecto |
|---|---|---|
| RC1 | Proveedor existe en maestro y está activo | Bloqueo |
| RC2 | Aprobación existe, dice "Aprobado" y viene de un aprobador del centro | Bloqueo |
| RC3 | Valor total ≤ tope del aprobador para ese centro | Bloqueo |
| RC4 | Subárea pertenece al centro de costo | Bloqueo |
| RC5 | Cotización presente y con desviación ≤ 2% respecto a la solicitud | Confirmación |
| RC6 | Indicador de IVA ausente → se deriva del maestro de proveedores | Confirmación + derivado |
| RC7 | Condiciones de pago ausentes → se derivan del maestro | Derivado (solo se informa) |
| RC8 | Factura anterior a la solicitud → OC retroactiva | Confirmación + marca en control |
| RC9 | Aprobación anterior a la solicitud | Confirmación |
| RC10 | cantidad × valor unitario ≈ valor total (±1) | Bloqueo |

## Casos del fixture

| Caso | Qué ejercita | Resultado esperado |
|---|---|---|
| sol-001 | Flujo feliz completo | OC creada sin intervención humana |
| sol-002 | Proveedor inexistente | Bloqueo RC1 con acción sugerida |
| sol-003 | Aprobador sin autoridad en el centro | Bloqueo RC2 con acción sugerida |
| sol-004 | Cotización con 6% de desviación | Confirmación RC5, luego OC |
| sol-005 | Factura previa a la solicitud | Confirmación RC8, OC retroactiva marcada |
| sol-006 | IVA y condiciones de pago ausentes | Derivados RC6/RC7 + confirmación |

## Qué NO hace el agente (límites explícitos)

- No se conecta a un SAP real (se diseña el adaptador, se simula con archivos).
- No recibe mercancía, no registra factura ni pago.
- No tiene autenticación de usuarios: el enlace es público por decisión del PRD.
- No altera los fixtures: son de solo lectura.

const express = require('express');
const { chromium } = require('playwright');

// 🟢 Red de seguridad: si algo inesperado lanza un error no controlado,
//    se registra en el log en vez de tumbar todo el servidor (como pasó
//    con el timeout de REMYPE que no tenía try/catch).
process.on('unhandledRejection', (reason) => {
    console.log('⚠ Unhandled Rejection (el servidor sigue corriendo):', reason);
});
process.on('uncaughtException', (err) => {
    console.log('⚠ Uncaught Exception (el servidor sigue corriendo):', err);
});

const app = express();
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

// 🟢 FRONTEND
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">

<head>

<meta charset="UTF-8">

<title>Consulta REMYPE + SUNAT</title>

<style>

*{
    margin:0;
    padding:0;
    box-sizing:border-box;
    font-family:Arial, Helvetica, sans-serif;
}

html,
body{

    width:100%;
    height:100%;
    overflow:hidden;

}

body{

    background:#082b55 url('/fondo.png') no-repeat center center;

    /*
        Se muestra TODA la imagen.
        Ya no se recorta.
    */
    background-size:contain;

}

/* ocupa toda la pantalla */
.wrapper{

    width:100%;
    height:100%;

    display:flex;
    align-items:center;

}

/* mueve el formulario unos 3 cm a la derecha */
.contenedor{

    width:430px;

    margin-left:115px;

}

h1{

    color:white;

    text-align:center;

    font-size:40px;

    font-weight:bold;

    line-height:1.15;

    margin-bottom:14px;

}

h3{

    color:white;

    text-align:center;

    font-size:19px;

    font-weight:normal;

    margin-bottom:45px;

}

input{

    width:100%;

    height:52px;

    border:none;

    border-radius:8px;

    text-align:center;

    font-size:19px;

    margin-bottom:28px;

    outline:none;

}

.btnPrincipal{

    width:100%;

    height:50px;

    background:#d71920;

    color:white;

    border:none;

    border-radius:8px;

    font-size:17px;

    cursor:pointer;

    transition:.25s;

}

.btnPrincipal:hover{

    background:#b40f15;

}

.btnSecundario{

    width:160px;

    height:44px;

    display:block;

    margin:18px auto 0;

    background:white;

    color:#003b74;

    border:none;

    border-radius:8px;

    cursor:pointer;

    font-size:16px;

    transition:.25s;

}

.btnSecundario:hover{

    background:#ececec;

}

</style>

</head>

<body>

<div class="wrapper">

<div class="contenedor">

<h1>

CONSULTA SUNAT +<br>
REMYPE

</h1>

<h3>

Desarrollado por JHurtado

</h3>

<form method="POST" action="/generar" id="formRuc">

<input
type="text"
name="ruc"
id="rucInput"
maxlength="11"
required
placeholder="Ingrese RUC">

<button
type="submit"
class="btnPrincipal">

Generar Consulta

</button>

<button
type="button"
class="btnSecundario"
onclick="document.getElementById('rucInput').value=''">

Limpiar

</button>

</form>

</div>

</div>

</body>

</html>
`);
});

// ==========================================================
// 🟦 FUNCIÓN AUXILIAR: capturar el primer .panel.panel-primary
//     visible de la página
// ==========================================================
async function capturarPrimerPanelPrimary(page, timeout = 20000) {
    const panel = page.locator('.panel.panel-primary').first();
    await panel.waitFor({ state: 'visible', timeout });
    return await panel.screenshot();
}

// ==========================================================
// 🟦 FUNCIÓN AUXILIAR: hacer clic esperando la navegación
// ==========================================================
async function clickYEsperarNavegacion(page, locator, timeout = 20000) {
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }).catch(() => {}),
        locator.click()
    ]);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
}

// ==========================================================
// 🟦 FLUJO SUNAT (RUC + Trabajadores + Representantes Legales)
//     Se ejecuta en su propia pestaña, en paralelo con REMYPE.
// ==========================================================
async function flujoSunat(browser, ruc) {
    let sunatBase64 = null;
    let sunatWorkersBase64 = null;
    let sunatRepLegalesBase64 = null;
    let sunatPage = null;

    try {
        sunatPage = await browser.newPage();

        // 🟢 Reintento simple: si el primer intento choca con el bloqueo
        //    anti-bot (ERR_CONNECTION_RESET), se reintenta un par de veces
        //    antes de dar el flujo de SUNAT por fallido.
        let sunatCargada = false;
        for (let intento = 1; intento <= 3 && !sunatCargada; intento++) {
            try {
                await sunatPage.goto(
                    'https://e-consultaruc.sunat.gob.pe/cl-ti-itmrconsruc/FrameCriterioBusquedaWeb.jsp',
                    { waitUntil: 'domcontentloaded', timeout: 20000 }
                );
                sunatCargada = true;
            } catch (e) {
                console.log(`⚠ Intento ${intento} fallido al entrar a SUNAT:`, e.message);
                if (intento < 3) await sunatPage.waitForTimeout(2000);
            }
        }
        if (!sunatCargada) {
            throw new Error('No se pudo cargar la página de SUNAT tras varios intentos.');
        }

        await sunatPage.waitForSelector('#txtRuc', { timeout: 15000 });
        await sunatPage.locator('#txtRuc').fill(ruc);

        await clickYEsperarNavegacion(sunatPage, sunatPage.locator('#btnAceptar'));

        await sunatPage.waitForSelector('.panel-heading:has-text("Resultado de la Búsqueda")', { timeout: 20000 });
        await sunatPage.waitForTimeout(1000);

        await sunatPage.evaluate(() => {
            document.querySelectorAll('.list-group-item, .panel-footer').forEach(el => {
                if (el.innerText && el.innerText.includes('Fecha consulta')) el.remove();
            });
        });

        const sunatBuffer = await capturarPrimerPanelPrimary(sunatPage);
        sunatBase64 = sunatBuffer.toString('base64');

        console.log("✓ Captura SUNAT (Resultado de la Búsqueda) obtenida");

        // ==========================================================
        // 🟦 CANTIDAD DE TRABAJADORES
        // ==========================================================
        const tabTrabajadores = sunatPage.locator('button', {
            hasText: 'Cantidad de Trabajadores y/o Prestadores de Servicio'
        }).first();

        await tabTrabajadores.waitFor({ timeout: 20000 });
        await clickYEsperarNavegacion(sunatPage, tabTrabajadores);

        try {
            await sunatPage.waitForSelector('.panel-heading:has-text("Información de Trabajadores")', { timeout: 20000 });
            const workersBuffer = await capturarPrimerPanelPrimary(sunatPage);
            sunatWorkersBase64 = workersBuffer.toString('base64');
            console.log("✓ Captura SUNAT (Cantidad de Trabajadores) obtenida");
        } catch (e) {
            console.log("⚠ No se encontró el cuadro de trabajadores, se omite:", e.message);
        }

        // ==========================================================
        // 🟦 VOLVER (history.go(-1)) y REPRESENTANTE(S) LEGAL(ES)
        // ==========================================================
        await Promise.all([
            sunatPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
            sunatPage.goBack()
        ]);
        await sunatPage.waitForTimeout(1500);

        const tabRepLegal = sunatPage.locator('button', {
            hasText: 'Representante(s) Legal(es)'
        }).first();

        await tabRepLegal.waitFor({ timeout: 20000 });
        await clickYEsperarNavegacion(sunatPage, tabRepLegal);

        try {
            await sunatPage.waitForSelector('.panel.panel-primary', { timeout: 20000 });
            const repLegalesBuffer = await capturarPrimerPanelPrimary(sunatPage);
            sunatRepLegalesBase64 = repLegalesBuffer.toString('base64');
            console.log("✓ Captura SUNAT (Representantes Legales) obtenida");
        } catch (e) {
            console.log("⚠ No se encontró el cuadro de representantes legales, se omite:", e.message);
        }

        await sunatPage.close();

    } catch (e) {
        console.log("⚠ Error SUNAT:", e.message);
        try { if (sunatPage) await sunatPage.close(); } catch (err) {}
    }

    return { sunatBase64, sunatWorkersBase64, sunatRepLegalesBase64 };
}

// ==========================================================
// 🟦 FLUJO REMYPE
//     Se ejecuta en su propia pestaña, en paralelo con SUNAT.
// ==========================================================
async function flujoRemype(browser, ruc) {
    let remypePage = null;

    try {
        remypePage = await browser.newPage();

        // 🟢 Reintento simple: al correr en serie (sin competir con SUNAT
        //    por la CPU), 25s debería alcanzar en la mayoría de los casos.
        //    Se deja 1 solo reintento como red de seguridad, para no
        //    desperdiciar minutos completos si de verdad está caído.
        let remypeCargada = false;
        for (let intento = 1; intento <= 2 && !remypeCargada; intento++) {
            try {
                await remypePage.goto(
                    'https://apps.trabajo.gob.pe/consultas-remype/app/index.html',
                    { waitUntil: 'domcontentloaded', timeout: 25000 }
                );
                remypeCargada = true;
            } catch (e) {
                console.log(`⚠ Intento ${intento} fallido al entrar a REMYPE:`, e.message);
                if (intento < 2) await remypePage.waitForTimeout(1500);
            }
        }
        if (!remypeCargada) {
            throw new Error('No se pudo cargar la página de REMYPE tras varios intentos.');
        }

        await remypePage.waitForTimeout(3000);

        const cerrarModal = async () => {
            try {
                const modal = remypePage.locator('#myModal');

                if (await modal.count() > 0) {
                    const botones = remypePage.locator('#myModal button, .modal button, .close, .btn-close');

                    const count = await botones.count();
                    for (let i = 0; i < count; i++) {
                        try {
                            await botones.nth(i).click({ force: true });
                        } catch (e) {}
                    }

                    await remypePage.keyboard.press('Escape').catch(() => {});
                    await remypePage.mouse.click(10, 10).catch(() => {});
                    await remypePage.waitForTimeout(1500);
                }
            } catch (e) {}
        };

        await cerrarModal();

        await remypePage.waitForSelector('input', { timeout: 15000 });
        await remypePage.locator('input').first().fill(ruc);

        await cerrarModal();

        await remypePage.locator('button', { hasText: 'Buscar' }).click();
        await remypePage.waitForTimeout(5000);

        const remypeBuffer = await remypePage.screenshot({ fullPage: true });

        console.log("✓ Captura REMYPE obtenida");

        return remypeBuffer.toString('base64');

    } catch (e) {
        console.log("⚠ Error REMYPE:", e.message);
        return null;
    } finally {
        if (remypePage) await remypePage.close().catch(() => {});
    }
}

// 🟢 BOT
app.post('/generar', async (req, res) => {

    const ruc = req.body.ruc;

    // 🟢 headless:true => corre invisible. Para que SUNAT no corte la
    //    conexión (ERR_CONNECTION_RESET), hay que evitar que el navegador
    //    se identifique como "headless": se desactiva la bandera de
    //    automatización y se usa un contexto con user-agent, idioma y
    //    tamaño de pantalla de un Chrome de escritorio normal.
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-PE',
        timezoneId: 'America/Lima'
    });

    // ==========================================================
    // 🟦 SUNAT y REMYPE corren EN SERIE (uno después del otro), no en
    //     paralelo. En el plan free de Render la CPU es muy limitada y
    //     compartida; correr las 2 automatizaciones a la vez hace que
    //     compitan por ese mismo recurso, lo que termina agotando los
    //     reintentos de REMYPE (y viceversa) en vez de ahorrar tiempo.
    //     En serie, cada flujo tiene toda la CPU disponible mientras
    //     corre, y en la práctica resuelve más rápido y sin fallar.
    // ==========================================================
    const sunatResultado = await flujoSunat(context, ruc);
    const remypeBase64 = await flujoRemype(context, ruc);

    const { sunatBase64, sunatWorkersBase64, sunatRepLegalesBase64 } = sunatResultado;

    // ==========================================================
    // 🟦 GENERAR PDF
    //     Hoja 1: SUNAT (Resultado de la Búsqueda)
    //     Hoja 2: Cantidad de Trabajadores + Representante(s) Legal(es)
    //     Hoja 3: REMYPE
    //     Todas las imágenes: ancho fijo 17 cm, alto variable
    //     Márgenes de página: 2 cm en los 4 lados
    // ==========================================================
    const ANCHO_CM = '17cm';
    const imgTag = (base64) => `
        <img src="data:image/png;base64,${base64}"
             style="width:${ANCHO_CM};height:auto;display:block;margin:0 auto;" />
    `;

    const seccionSunatRuc = sunatBase64
        ? `
        <h2>REPORTE SUNAT</h2>
        <p><b>RUC:</b> ${ruc}</p>
        ${imgTag(sunatBase64)}
        `
        : `
        <h2>REPORTE SUNAT</h2>
        <p><b>RUC:</b> ${ruc}</p>
        <p><i>No se pudo obtener la información de SUNAT.</i></p>
        `;

    const seccionTrabajadores = sunatWorkersBase64
        ? `
        <h2>CANTIDAD DE TRABAJADORES</h2>
        ${imgTag(sunatWorkersBase64)}
        `
        : `
        <h2>CANTIDAD DE TRABAJADORES</h2>
        <p><i>No se pudo obtener esta información.</i></p>
        `;

    const seccionRepLegales = sunatRepLegalesBase64
        ? `
        <br><br>
        <h2>REPRESENTANTE(S) LEGAL(ES)</h2>
        ${imgTag(sunatRepLegalesBase64)}
        `
        : `
        <br><br>
        <h2>REPRESENTANTE(S) LEGAL(ES)</h2>
        <p><i>No se pudo obtener esta información.</i></p>
        `;

    const htmlReporte = `
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            * { box-sizing: border-box; }
            body {
                font-family: Arial;
                color: black;
                margin: 0;
            }
            h2 { margin-top: 0; }
            .hoja {
                page-break-after: always;
            }
            .hoja:last-child {
                page-break-after: auto;
            }
        </style>
    </head>
    <body>

        <div class="hoja">
            ${seccionSunatRuc}
        </div>

        <div class="hoja">
            ${seccionTrabajadores}
            ${seccionRepLegales}
        </div>

        <div class="hoja">
            <h2>REPORTE REMYPE</h2>
            <p><b>RUC:</b> ${ruc}</p>
            ${remypeBase64
                ? imgTag(remypeBase64)
                : '<p><i>No se pudo obtener la información de REMYPE.</i></p>'}
        </div>

    </body>
    </html>
    `;

    // 🟢 Renderizar el HTML del reporte a PDF con márgenes de 2cm exactos
    //    (se genera en memoria, SIN escribir el archivo en la carpeta del
    //    server, para que varios usuarios puedan generar reportes al mismo
    //    tiempo sin acumular ni chocar archivos en el disco del servidor)
    const reportPage = await context.newPage();
    await reportPage.setContent(htmlReporte, { waitUntil: 'load' });

    const pdfBuffer = await reportPage.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
            top: '2cm',
            bottom: '2cm',
            left: '2cm',
            right: '2cm'
        }
    });

    await reportPage.close();
    await context.close();
    await browser.close();

    const fileName = `Consulta_ruc_remype_${ruc}.pdf`;

    console.log("✓ PDF generado en memoria:", fileName);

    // 🟢 Se envía el PDF directamente al navegador del usuario, que lo
    //    guardará en SU carpeta de Descargas (no en el servidor).
    res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor listo en el puerto ${PORT}`);
});

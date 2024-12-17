import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Ai } from '@cloudflare/ai';

type Env = {
    AI: Ai;
	DB: D1Database;
	VECTORIZE: Vectorize;
};

const app = new Hono<{ Bindings: Env }>();
app.use(cors());

app.post('/', async (c) => {

    let body;
    try {
        body = await c.req.json();
    } catch (error) {
        console.error("Error al parsear el cuerpo de la solicitud:", error);
        return c.text("Cuerpo de solicitud inválido o vacío", 400);
    }

    const messages: RoleScopedChatInput[] = body.messages;

    if (!messages || messages.length === 0) return c.text("No se han proporcionado mensajes", 400);

	// const userMessages = messages.filter(msg => msg.role === 'user');

	const lastMessages = messages.length > 4 ? messages.slice(-4) : messages.slice(1);

	const combinedText = lastMessages.map(msg => msg.content).join(' ');
	console.log(combinedText)

	const embeddings = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
	    text: combinedText,
	});

	const vectors = embeddings.data[0];

	const vectorQuery = await c.env.VECTORIZE.query(vectors, { topK: 3 });
	let vecIds: any[] = [];

	if (vectorQuery?.matches?.length) {
		vecIds = vectorQuery.matches
    		.sort((a, b) => b.score - a.score)
    		.map(match => match.id);
		console.log("Resultado de la búsqueda vectorial:", vectorQuery);
	} else {
		console.log("No hubo resultados de la búsqueda vectorial:", vectorQuery);
	}

	let notes: any[] = [];

	if (vecIds.length > 0) {
		const placeholders = vecIds.map(() => '?').join(', ');
		const query = `SELECT id, campus, nombre, contenido FROM notas WHERE id IN (${placeholders})`;
		const { results } = await c.env.DB.prepare(query).bind(...vecIds).all();
		if (results) {
			notes = results;
		}
	}

	const contextMessage = notes.length
    	? `Notas relevantes:\n${notes.map((note) =>
    	    note.campus === "General"
    	        ? `- [Información general ${note.nombre}: ${note.contenido}] `
    	        : `- [Campus: ${note.campus} ${note.nombre}: ${note.contenido}] `
    	).join("\n")}`
    	: "";

	console.log(notes.length, contextMessage);

	const systemPrompt = `
		[Contexto]
		Eres LobAi, el asistente virtual de la Universidad Autónoma de Durango (UAD). Nuestra mascota es un lobo y nuestro lema es "¡Somos grandes, Somos Lobos!". La UAD es una institución privada de excelencia académica con más de 30 campus en toda la República Mexicana y 33 años de historia. Cada campus cuenta con su propia oferta académica. Tu función es responder preguntas sobre la UAD con información clara, oficial, concisa (máximo 80 palabras) y siempre en español. No menciones el acceso a datos adicionales o contextos externos.

		[Requisitos Generales]
		- Utiliza las notas relevantes para responder a las preguntas como tu unica fuente de verdad. pero nunca menciones la existencia de notas relevantes al usuario, el proceso debe ser transparente (MUY IMPORTANTE).
		- Si el usuario hace una pregunta o solicitud no relacionada con la UAD, responde que no puedes responder a esa solicitud porque tu funcion es proporcionar información sobre la UAD.
		- Si no hay información exacta, sé útil con los datos disponibles, pero nunca inventes información sobre campus, ubicaciones u ofertas académicas. (MUY IMPORTANTE).
		- Prioriza respuestas que refuercen la identidad de la universidad.
		- Mantén un tono profesional, pero amigable, cálido, claro, en primera persona, como representante oficial de la UAD.

		[Reglas Específicas](Que debes seguir estrictamente):
		1. Responde únicamente a preguntas relacionadas con la UAD. Si la pregunta es sobre la UAD pero no tienes información exacta, brinda una respuesta útil basada en los datos disponibles.
		2. Nunca inventes información sobre campus o ubicaciones (MUY IMPORTANTE).
		3. No responderás a temas de creación de contenido (poemas, chistes, etc.), ni sobre información personal del usuario o cualquier otra información que no esté relacionada con la universidad..
		4. Proporciona respuestas directas y seguras basadas en los datos proporcionados.
		5. Si un usuario pregunta sobre un campus o programa en una ubicación donde la UAD no tiene presencia, informa amablemente que actualmente no hay un campus en esa ubicación y proporciona información sobre la modalidad en linea Santander Live Streaming, o en su caso, el campus más cercano a su ubicación.
		6. Bajo ninguna circunstancia debes inventar informacion de campus u ofertas académicas inexistentes, apegate en todo momento a la informacion proporcionada y las notas relevantes. (MUY IMPORTANTE).
		7. Bajo ninguna circunstancia ofrezcas información financiera (colegiaturas, inscripciones, costos, etc): Si el usuario solicita información financiera, responde explicando que tu función es proporcionar información general sobre los campus y su oferta académica. En caso de que desee información financiera, indícale que puede obtenerla directamente a través del contacto del campus correspondiente. Si el usuario no menciona un campus específico, pregúntale cuál es el de su interés para poder proporcionarle los datos de contacto adecuados.

		[Campus Disponibles] (Estado: campus):
			Aguascalientes: Aguascalientes
			Baja California: Ensenada, Mexicali, Tijuana
			Chihuahua: Chihuahua, Cd. Juárez
			Coahuila: Acuña, Monclova, Piedras Negras, Saltillo, Torreón
			Durango: Alamedas, Durango, Laguna, Santiago Papasquiaro
			Hidalgo: Pachuca
			Michoacán: Morelia
			Nuevo León: Monterrey
			Sinaloa: Culiacán, Guasave, Los Mochis, Mazatlán
			Sonora: Cd. Obregón, Hermosillo, Nogales
			Zacatecas: Fresnillo, Fundadores, Zacatecas
			México: CDMX, Revolución

		[Formato de Enlaces]
		Usa el formato:
		https://www.uad.mx/{estado en minusculas}/campus-{nombre del campus en minusculas}/
		Ejemplo: https://www.uad.mx/aguascalientes/campus-aguascalientes/
		Importante:
		- Respetar la estructura exacta.
		- No existen páginas de estados sin el “campus-nombre”.
		- Respetar tildes en el enlace, por ejemplo: https://www.uad.mx/chihuahua/campus-cd-juárez/

		[Estilo de Respuesta]
		En todas las respuestas relacionadas con la UAD, habla como vocero oficial de la institución. Por ejemplo:
		- Usuario: ¿Qué carreras tienen en el Campus Durango?
		- LobAi: En el Campus Durango ofrecemos las carreras de Gastronomía, Psicología, Arquitectura...
		MUY IMPORTANTE siempre hablar en primera persona (nuestra página, nuestro campus, nuestra oferta académica, etc.).

		[Instrucción Inicial]
		Si el usuario solicita información general sin especificar campus, primero pregunta por el campus de interés. Si no existe campus en su ciudad y le interesa alguna licenciatura que no sea medicina o enfermería puedes ofrecerle información de la modalidad en linea Santander Live Streaming. Pero recuerda que para medicina o enfermería se ofrece la modalidad Medicina Mixta Virtual, sin mencionar Santander Live Streaming ya que son plataformas distintas.

		RECUERDA NUNCA INVENTAR INFORMACIÓN SOBRE CAMPUS, UBICACIONES U OFERTAS ACADÉMICAS DE LAS QUE NO TENGAS CERTEZA, LAS NOTAS RELEVANTES SON TU ÚNICA FUENTE DE VERDAD, SI NO TIENES INFORMACIÓN SUFICIENTE NO SE LO INFORMES AL USUARIO DE FORMA EXPLICITA. EL PROCESO DEBE SER TRANSPARENTE PARA EL USUARIO. SI NO PUEDES RESPÓNDER SOLO INDICA QUE NO TIENES ESA INFORMACIÓN Y SI SE TE PROPORCIONAN DATOS DE CONTACTO PROPORCIONALOS AL USUARIO.
		RECUERDA NUNCA OFRECER AL USUARIO INFORMACIÓN DE COSTOS.
		RECUERDA MANTENER UN TONO PROFESIONAL, PERO AMIGABLE, CÁLIDO, CLARO Y EN PRIMERA PERSONA, COMO REPRESENTANTE OFICIAL DE LA UAD.
	`;

    let stream;

    try {
        stream = await c.env.AI.run(
            // @ts-ignore
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            {
                messages: [
					...(notes.length ? [{ role: 'assistant', content: contextMessage }] : []),
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ],
                stream: true,
				temperature: 0.1,
            }
        ) as ReadableStream;
    } catch (error) {
        console.error("Error al ejecutar la API de AI:", error);
        return c.text("Error al procesar la solicitud", 500);
    }

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
        },
    });
});

app.post("/notes", async (c) => {
    const { campus, nombre, contenido } = await c.req.json();

    if (!campus || !nombre || !contenido) {
        return c.text("Los campos 'campus', 'nombre' y 'contenido' son obligatorios.", 400);
    }

    const { results } = await c.env.DB.prepare(
        `INSERT INTO notas (campus, nombre, contenido) VALUES (?, ?, ?) RETURNING *`
    )
        .bind(campus, nombre, contenido)
        .run();

    const record = results.length ? results[0] : null;
    if (!record) return c.text("Error al insertar la nota", 500);

    const { data } = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: campus === "General"
		? [`Información general | Nombre: ${nombre} | Contenido: ${contenido}`]
		: [`Campus: ${campus} | Nombre: ${nombre} | Contenido: ${contenido}`],
    });

    const values = data[0];
    if (!values) return c.text("Error al generar embedding", 500);

    const id = record.id as number;
    await c.env.VECTORIZE.upsert([
        {
            id: id.toString(),
            values,
        },
    ]);

    return c.json({ id, campus, nombre, contenido });
});



app.get("/notes", async (c) => {
	const query = `SELECT id, campus, nombre, contenido FROM notas`;
	const { results } = await c.env.DB.prepare(query).all();

	return c.json(results);
});

app.delete("/notes/:id", async (c) => {
	const { id } = c.req.param();

	const query = `DELETE FROM notas WHERE id = ?`;
	await c.env.DB.prepare(query).bind(id).run();

	await c.env.VECTORIZE.deleteByIds([id]);

	return c.status(204);
});

app.put("/notes/:id", async (c) => {
    const { id } = c.req.param();
    const { campus, nombre, contenido } = await c.req.json();

    if (!campus && !nombre && !contenido) {
        return c.text("Debes proporcionar al menos un campo para actualizar.", 400);
    }

    const updates = [];
    const values = [];
    if (campus) {
        updates.push("campus = ?");
        values.push(campus);
    }
    if (nombre) {
        updates.push("nombre = ?");
        values.push(nombre);
    }
    if (contenido) {
        updates.push("contenido = ?");
        values.push(contenido);
    }
    values.push(id);

    const query = `UPDATE notas SET ${updates.join(", ")} WHERE id = ?`;

    const { success } = await c.env.DB.prepare(query).bind(...values).run();

    if (!success) {
        return c.text("Error al actualizar la nota.", 500);
    }

    if (contenido || campus || nombre) {
        const { data } = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
            text: campus === "General"
                ? [`Información general | Nombre: ${nombre} | Contenido: ${contenido}`]
                : [`Campus: ${campus} | Nombre: ${nombre} | Contenido: ${contenido}`],
        });

        const values = data[0];
        if (values) {
            await c.env.VECTORIZE.upsert([
                {
                    id: id.toString(),
                    values,
                },
            ]);
        }
    }

    return c.text("Nota actualizada con éxito.");
});

export default app;

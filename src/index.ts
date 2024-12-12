import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Ai } from '@cloudflare/ai';

type Env = {
    AI: Ai;
	DB: D1Database;
	VECTORIZE: Vectorize;
};

type Note = {
	id: string;
	text: string;
}

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

	const userMessages = messages.filter(msg => msg.role === 'user');

	const lastThreeUserMessages = userMessages.slice(-4);

	const combinedText = lastThreeUserMessages.map(msg => msg.content).join(' ');
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
		Eres LobAi, el asistente virtual de la Universidad Autónoma de Durango (UAD). Nuestra mascota es un lobo y nuestro lema es "Somos grandes, Somos Lobos". La UAD es una institución privada de excelencia académica con más de 30 campus en toda la República Mexicana, cada uno con su propia oferta académica.
		Tu función es proporcionar respuestas claras en español a las preguntas de los usuarios sobre la universidad, adaptándote al contexto específico si se te proporciona información adicional. Nunca menciones que tienes acceso a datos adicionales o contextos externos.
		Prioriza respuestas que refuercen la identidad de la universidad. Sé amable y eficiente en todo momento.
		Si el usuario realiza una solicitud que no está relacionada con la universidad no respondas a la solicitud, simplemente responde: "Lo siento, no puedo responder a esta solicitud porque tu funcion es proporcionar información sobre la UAD".
		Elabora respuestas cortas y concisas, no mas de 80 palabras.

		- Si se te proporcionan notas relevantes, debes utilizarla como tu única fuente de verdad.

		Reglas que debes seguir estrictamente:
			1. Responde únicamente a preguntas relacionadas con la UAD y su oferta académica. Si la pregunta es sobre la UAD pero no tienes información exacta, brinda una respuesta útil basada en los datos disponibles.
			2. Nunca inventes información sobre campus o ubicaciones (MUY IMPORTANTE).
			3. No responderás a temas de entretenimiento, creación de contenido, ni información personal del usuario o cualquier otra información que no esté relacionada con la universidad.
			4. Proporciona respuestas directas y seguras basadas en los datos proporcionados.
			5. Si un usuario pregunta sobre un campus o programa en una ubicación donde la UAD no tiene presencia, informa amablemente que actualmente no hay un campus en esa ubicación y proporciona información sobre dónde se ofrece el programa o campus más cercano.
			6. Bajo ninguna circunstancia debes inventar detalles numéricos, como precios, fechas, cantidades, u otra información concreta que no esté explícitamente proporcionada. Si no tienes información, indica claramente que no la tienes (MUY IMPORTANTE).
			7. Bajo ninguna circunstancia debes inventar informacion de campus inexistentes, apegate en todo momento a la informacion proporcionada y las notas relevantes. (MUY IMPORTANTE).

		Estos son los campus de la UAD (Estado: campus):
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

		Responde siempre como si fueras parte de la institución UAD. Habla en primera persona y utiliza un tono profesional, cálido y claro. Al brindar información, hazlo como un representante oficial de la institución. Por ejemplo:

			-	Usuario: ¿Qué carreras tienen en el Campus Durango?
			-	Asistente: En el Campus Durango ofrecemos las carreras de Gastronomía, Psicología, Arquitectura...

		Mantén este estilo en todas las respuestas relacionadas con información institucional."

		Si un usuario pide información general, pregunta primero de cuál campus en específico está interesado, si el usuario le interesa estudiar en la universidad pero no hay campus en su ciudad ofrecele informacion del campus más cercano o las modalides en linea.

		Para proporcionar el link de un campus especifico al usuario puedes utilizar la estructura de enlaces que se muestra a continuación:
		https://www.uad.mx/{estado en minusculas}/campus-{nombre del campus en minusculas}/
		Ejemplo: https://www.uad.mx/aguascalientes/campus-aguascalientes/
		Es importante siempre enviar el link con la estructura comleta ya que no se cuenta con paginas de estados, por ejemplo https://www.uad.mx/aguascalientes/ no existe, solo existe https://www.uad.mx/aguascalientes/{campus-nombre-en-minusculas}/
		También es importante que respetes las tildes en la estrucura de enlaces, por ejemplo https://www.uad.mx/chihuahua/campus-cd-juárez/
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

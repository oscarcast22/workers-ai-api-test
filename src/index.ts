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

	const lastThreeUserMessages = userMessages.slice(-8);

	const combinedText = lastThreeUserMessages.map(msg => msg.content).join(' ');
	console.log(combinedText)

	const embeddings = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
	    text: combinedText,
	});

	const vectors = embeddings.data[0];

	const vectorQuery = await c.env.VECTORIZE.query(vectors, { topK: 3 });
	console.log('matches:', vectorQuery.matches)
	let vecIds: any[] = [];

	if (vectorQuery?.matches?.length) {
		vecIds = vectorQuery.matches.map(match => match.id);
		console.log("Resultado de la búsqueda vectorial:", vectorQuery);
	} else {
		console.log("No hubo resultados de la búsqueda vectorial:", vectorQuery);
	}

	let notes: any[] = [];

	if (vecIds.length > 0) {
		console.log(vecIds.length)
		const placeholders = vecIds.map(() => '?').join(', ');
		console.log('Placeholders', placeholders);
		const query = `SELECT * FROM notes WHERE id IN (${placeholders})`;
		const { results } = await c.env.DB.prepare(query).bind(...vecIds).all();
		if (results) notes = results.map((vect) => vect.text);
		console.log(notes.length)
	}

	const contextMessage = notes.length
		? `${notes.map((note) => `- ${note}`).join("\n")}`
		: "";

	console.log("Contexto de la conversación:", contextMessage);

	const systemPrompt = `
		Eres LobAi, el asistente virtual de la Universidad Autónoma de Durango (UAD). Nuestra mascota es un lobo y nuestro lema es "Somos grandes, Somos Lobos". La UAD es una institución privada de excelencia académica con más de 30 campus en toda la República Mexicana, cada uno con su propia oferta académica.
		Tu función es proporcionar respuestas claras en español a las preguntas de los usuarios sobre la universidad, adaptándote al contexto específico si se te proporciona información adicional. Nunca menciones que tienes acceso a datos adicionales o contextos externos.
		Prioriza respuestas que refuercen la identidad de la universidad. Sé amable y eficiente en todo momento.
		Si el usuario realiza una solicitud que no está relacionada con la universidad, responde: "Lo siento, no puedo responder a esta solicitud porque no está relacionada con la UAD".

		Reglas que debes seguir estrictamente:
			1. Responde únicamente a preguntas relacionadas con la UAD y su oferta académica. Si la pregunta es sobre la UAD pero no tienes información exacta, brinda una respuesta útil basada en los datos disponibles.
			2. Nunca inventes información sobre campus o ubicaciones.
			3. No responderás a temas de entretenimiento, noticias externas, ni información personal del usuario o cualquier otra información que no esté relacionada con la universidad.
			4. Proporciona respuestas directas y seguras basadas en los datos proporcionados.
			5. Si un usuario pregunta sobre un campus o programa en una ubicación donde la UAD no tiene presencia, informa amablemente que actualmente no hay un campus en esa ubicación y proporciona información sobre dónde se ofrece el programa o campus más cercano.

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

		Si un usuario pide información general, pregunta primero de cuál campus en específico está interesado, si el usuario le interesa estudiar en la universidad pero no hay campus en su ciudad ofrecele informacion del campus más cercano.
	`;

    let stream;

    try {
        stream = await c.env.AI.run(
            // @ts-ignore
            "@cf/meta/llama-3.1-70b-instruct",
            {
                messages: [
					...(notes.length ? [{ role: 'assistant', content: contextMessage }] : []),
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ],
                stream: true,
				temperature: 0.4,
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

// Inserta notas en la base de datos D1
// Generar embeddings de las notas
// Insertar las embeddings en vectorizer
app.post('/notes', async (c) => {
    const { text } = await c.req.json();
	if (!text) return c.text("Texto no proporcionado", 400);

	console.log(text);

	const { results } = await c.env.DB.prepare(
		`INSERT INTO notes (text) VALUES (?) RETURNING *`
	)
		.bind(text)
		.run() as { results: Note[] };

	console.log(results);

	const record = results.length ? results[0] : null;
	if (!record) return c.text("Error al insertar la nota", 500);

	const { data } = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
		text: [text],
	})

	const values = data[0];

	if (!values) return c.text("Error al generar el embedding", 500);

	const { id } = record;
	const inserted = await c.env.VECTORIZE.upsert([
		{
			id: id.toString(),
			values,
		}
	])

	return c.json({ id, text, inserted });
});

app.get("/notes", async (c) => {
	const query = `SELECT * FROM notes`;
	const { results } = await c.env.DB.prepare(query).all();

	return c.json(results);
});

app.delete("/notes/:id", async (c) => {
	const { id } = c.req.param();

	const query = `DELETE FROM notes WHERE id = ?`;
	await c.env.DB.prepare(query).bind(id).run();

	await c.env.VECTORIZE.deleteByIds([id]);

	return c.status(204);
});

export default app;

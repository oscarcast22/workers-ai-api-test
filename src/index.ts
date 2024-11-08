import { Hono, Next } from 'hono';
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

	const embeddings = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
		text: messages[messages.length - 1].content,
	})

	const vectors = embeddings.data[0];

	const vectorQuery = await c.env.VECTORIZE.query(vectors, { topK: 1 });
    let vecId;

	if (vectorQuery?.matches?.length) {
		vecId = vectorQuery.matches[0].id;
		console.log("Resultado de la búsqueda vectorial:", vectorQuery);
	} else {
		console.log("No hubo resultados de la búsqueda vectorial:", vectorQuery);
	}

	let notes: any[] = [];

	if (vecId) {
		const query = `SELECT * FROM notes WHERE id = ?`;
		const { results } = await c.env.DB.prepare(query).bind(vecId).all();
		if (results) notes = results.map((vect) => vect.text);
	}

	const contextMessage = notes.length
		? `Context:\n${notes.map((note) => `- ${note}`).join("\n")}`
		: "";

    const systemPrompt = 'Eres un promotor de la universidad autonoma de Durango, la mascota de la universidad es un Lobo y tu te llamas LobAi. Responderas todas las preguntas del usuario en español, usa el contexto proporcionado para responder a la pregunta si es proporcionado y relevante';

    let stream;

    try {
        stream = await c.env.AI.run(
            // @ts-ignore
            "@cf/meta/llama-3.1-70b-instruct",
            {
                messages: [
					...(notes.length ? [{ role: 'user', content: contextMessage }] : []),
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ],
                stream: true,
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

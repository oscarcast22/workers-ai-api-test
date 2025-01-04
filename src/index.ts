import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Ai } from '@cloudflare/ai';
import { systemPrompt } from './systemPrompt';

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

	const lastMessages = messages.length > 3 ? messages.slice(-3) : messages.slice(1);

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
    	        ? `- [${note.nombre}: ${note.contenido}] `
    	        : `- [Campus: ${note.campus} ${note.nombre}: ${note.contenido}] `
    	).join("\n")}`
    	: "";

	console.log(notes.length, contextMessage);

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
				temperature: 0,
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

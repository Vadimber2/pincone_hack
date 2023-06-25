const faunadb = require("faunadb");
const axios = require("axios");

const q = faunadb.query;

const client = new faunadb.Client({
    secret: process.env.FAUNA_API_KEY,
});

const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;

async function sendTextToTelegramBot(message, chatId) {
    const apiUrl = `https://api.telegram.org/bot${TELEGRAM_API_KEY}/sendMessage`;

    const payload = {
        chat_id: chatId,
        text: message
    };

    try {
        const response = await axios.post(apiUrl, JSON.stringify(payload), {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.status !== 200) {
            console.error(`HTTP error! status: ${response.status}`);
        }

    } catch (error) {
        console.error('Error sending message to Telegram:', error);
    }
}

async function getChatIdFromDB(predictionId) {
    try {
        const result = await client.query(
            q.Get(
                q.Match(
                    q.Index('predictionId_index'), predictionId
                )
            )
        );
        console.log(result.data.chatId);
        return result.data.chatId;
    } catch (error) {
        console.error('Error getting chatId from DB:', error);
    }
}

exports.handler = async function (event, context) {
    if (event.httpMethod === "POST") {
        try {
            const data = JSON.parse(event.body);
            const predictionId = data.id;
            const chatId = await getChatIdFromDB(predictionId);
            const matches = data.output;

            if (matches != null) {
                let indata = JSON.stringify(matches);

                const regex_urls = /'product_url':\s*'([^']*)'/g;
                let match;
                let urls = [];

                while ((match = regex_urls.exec(indata)) !== null) {
                    urls.push(match[1]);
                }

                const promises = urls.map(url => sendTextToTelegramBot(url, chatId).catch(error => {
                    console.error(`Error sending message to Telegram for URL ${url}:`, error);
                }));

                await Promise.all(promises);

                return {
                    statusCode: 200,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                    },
                    body: JSON.stringify({}), // You may want to return something more meaningful here
                };
            } else {
                return {
                    statusCode: 404,
                    body: JSON.stringify({message: "Prediction not found"}),
                };
            }
        } catch (error) {
            return {
                statusCode: 500,
                body: JSON.stringify({message: "An error occurred", error: error.message}),
            };
        }
    } else {
        return {
            statusCode: 405,
            body: JSON.stringify({message: "Method not allowed"}),
        };
    }
};

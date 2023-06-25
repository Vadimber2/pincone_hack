// bot-to-replicate.js
//const AWS = require('aws-sdk');
const axios = require('axios');//.default;
const rateLimit = require('axios-rate-limit');
const stream = require('stream');
const faunadb = require('faunadb');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;

const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SECRET
});

const signedUrlExpireSeconds = 60 * 30; // URL will be valid for 30 minutes
const q = faunadb.query;
const client = new faunadb.Client({
  secret: process.env.FAUNA_API_KEY,
});

// Limiting to 100 requests per minute to avoid overloading third-party services
const http = rateLimit(axios.create(), { maxRequests: 100, perMilliseconds: 60000 });

async function getFilePath(fileId) {
  const response = await http.get(`https://api.telegram.org/bot${TELEGRAM_API_KEY}/getFile?file_id=${fileId}`);
  return response.data.result.file_path;
}

async function getFileAndUploadToCloudinary(fileId) {
  const filePath = await getFilePath(fileId);
  const response = await http.get(`https://api.telegram.org/file/bot${TELEGRAM_API_KEY}/${filePath}`, { responseType: 'stream' });

  // create a pass-through stream
  const pass = new stream.PassThrough();
  response.data.pipe(pass);

  try {
    // Upload the file to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const upload_stream = cloudinary.uploader.upload_stream((error, result) => {
        if (error) reject(error)
        else resolve(result);
      });

      pass.pipe(upload_stream);
    });

    console.log('File uploaded successfully. URL:', result.secure_url);
    return result.secure_url;
  } catch (err) {
    console.log('Error uploading file:', err);
    throw err;
  }
}

async function sendTextToTelegramBot(message, chatId) {
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_API_KEY}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message
  };

  try {
    const response = await http.post(apiUrl, JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.status !== 200) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

  } catch (error) {
    console.error('Error sending message to Telegram:', error);
    throw error;
  }
}

async function saveChatToDB(predictionId, chatId) {
  try {
    const result = await client.query(
      q.Create(
        q.Collection('chats'),
        { data: { predictionId: predictionId, chatId: chatId } },
      )
    );
    console.log(result.ref.id);
  } catch (error) {
    console.log('Error saving chat to DB:', error);
    throw error;
  }
}

exports.handler = async function (event, context) {
  if (event.httpMethod === "POST") {
    const body = JSON.parse(event.body);

    try {
      if (!body.message.photo) {
        await sendTextToTelegramBot('Пожалуйста, загрузите изображение.', body.message.chat.id);
        return {
          statusCode: 200,
          body: JSON.stringify({ status: 'Message processed' }),
        };
      }

      const middleIndex = Math.floor(body.message.photo.length / 2);
      const fileId = body.message.photo[middleIndex].file_id;
      const chatId = body.message.chat.id;

      //const imageUrl = await getFileAndUploadToS3(fileId);
      const imageUrl = await getFileAndUploadToCloudinary(fileId);

      const requestBody = {
        version: "48c8fb33c6d6fca3a66d094c2324e2129f3b707d8110b84722f58cac2588a17a",
        input: {
          image: imageUrl,
        },
        webhook: 'https://imagine.xpertnetz.com/api/bothook-from-replicate',
        webhook_events_filter: ["completed"],
      };

      const predictionResponse = await http.post("https://api.replicate.com/v1/predictions", requestBody, {
        headers: {
          "Authorization": `Token ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      });

      const predictionData = predictionResponse.data;
      const predictionId = predictionData.id;

      await saveChatToDB(predictionId, chatId);

      return {
        statusCode: 200,
        body: JSON.stringify({ predictionId }),
      };
    } catch (error) {
      console.log(error);
      return {
        statusCode: error.response ? error.response.status : 500,
        body: JSON.stringify({ message: error.response ? error.response.statusText : 'Internal Server Error' }),
      };
    }

  } else {
    return {
      statusCode: 405,
      body: JSON.stringify({ message: "Method not allowed" }),
    };
  }
};


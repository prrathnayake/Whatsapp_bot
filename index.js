require('dotenv').config();

const startBot = require('./bot');
const { ports } = require('./microservices/registry');
const { startChatService } = require('./microservices/chat');
const { startModerationService } = require('./microservices/moderation');
const { startYouTubeService } = require('./microservices/youtube');
const { startImageService } = require('./microservices/image');

async function bootstrap() {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY environment variable. Please configure your .env file.');
    }

    const starters = [
        startChatService({ port: ports.chat }),
        startModerationService({ port: ports.moderation }),
        startYouTubeService({ port: ports.youtube }),
        startImageService({ port: ports.image })
    ];

    const services = await Promise.all(starters);

    const closeAll = async () => {
        for (const service of services) {
            try {
                await service.close();
            } catch (error) {
                console.warn(`⚠️ Failed to close ${service.name} service cleanly`, error);
            }
        }
    };

    try {
        await startBot();
        console.log('🤖 WhatsApp bot initialised.');
    } catch (error) {
        console.error('Failed to start WhatsApp bot:', error);
        await closeAll();
        process.exit(1);
    }

    process.on('SIGINT', async () => {
        console.log('\nGracefully shutting down...');
        await closeAll();
        process.exit(0);
    });
}

bootstrap().catch((error) => {
    console.error('Unable to bootstrap application:', error);
    process.exit(1);
});

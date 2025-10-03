const ports = {
    chat: Number(process.env.CHAT_SERVICE_PORT || 4100),
    moderation: Number(process.env.MODERATION_SERVICE_PORT || 4101),
    youtube: Number(process.env.YOUTUBE_SERVICE_PORT || 4102),
    image: Number(process.env.IMAGE_SERVICE_PORT || 4103)
};

function getServiceUrl(name) {
    const port = ports[name];
    if (!port) {
        throw new Error(`Unknown service requested: ${name}`);
    }

    return `http://localhost:${port}`;
}

module.exports = {
    ports,
    getServiceUrl
};

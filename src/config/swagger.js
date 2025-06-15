const swaggerJsDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'DeadLink Watchdog API',
      version: '1.0.0',
      description: 'API documentation for DeadLink Watchdog - Nigerian Website Link Monitor',
      contact: {
        name: 'API Support',
        email: 'support@deadlink.example.com'
      }
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [{
      bearerAuth: []
    }]
  },
  apis: [
    './src/routes/*.js',
    './src/models/*.js'
  ]
};

const swaggerSpec = swaggerJsDoc(options);

module.exports = swaggerSpec;

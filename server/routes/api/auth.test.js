const request = require('supertest');
const app = require("./auth.js");
const User = require('../../models/user.js');

describe('Authentication Routes', () => {
  const testUser = {
    email: 'testuser@example.com',
    password: 'testpassword',
    firstName: 'Test',
    lastName: 'User',
    isSubscribed: true,
  };

const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;


  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create(); // Use `create` method
  const uri = await mongoServer.getUri();
    await User.create(testUser);
  }, 15000);

  afterAll(async () => {
   
    // Clean up: Remove the test user from the database
    await User.deleteOne({ email: testUser.email });
    await mongoServer.stop();
  }, 15000);

  it('should register a new user and return a valid token', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send(testUser);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('token');
    expect(response.body).toHaveProperty('user');
    
  });

  it('should handle registration with an existing email', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send(testUser);

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('error');
  });

  it('should login a user and return a valid token', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: testUser.email,
        password: testUser.password,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('token');
    expect(response.body).toHaveProperty('user');
  });

  it('should handle login with invalid credentials', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'invalid@example.com',
        password: 'invalidpassword',
      });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('error');
  });

});

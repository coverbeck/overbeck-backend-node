import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';

describe('AppService', () => {
  let service: AppService;
  const OLD_ENV = process.env;

  beforeEach(async() => {
    jest.resetModules();
    process.env.APIKEY = '123456';
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
    }).compile();
    service = module.get<AppService>(AppService);
  });

  afterEach(() => {
    process.env = OLD_ENV;
  })

  it ('should validate api key', () => {
    expect(service.authorize(null)).toBe(false);
    expect(service.authorize('123456')).toBe(true);
    expect(service.authorize('1234567')).toBe(false);
  });
});

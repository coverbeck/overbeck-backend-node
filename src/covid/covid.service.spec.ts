import {HttpModule} from "@nestjs/common";
import { Test, TestingModule } from '@nestjs/testing';
import { CovidService } from './covid.service';

describe('CovidService', () => {
  let service: CovidService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [HttpModule],
      providers: [CovidService],
    }).compile();

    service = module.get<CovidService>(CovidService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should fetch CA data', done => {
    service.getCaliforniaCovidData().subscribe(data => {
      expect(data.length).toBeGreaterThan(1000);
      done();
    })
  })
});

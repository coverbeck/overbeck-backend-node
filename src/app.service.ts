import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  private readonly APIKEY = process.env.APIKEY;

  authorize(apikey: string | null): boolean {
    return this.APIKEY === apikey;
  }

}

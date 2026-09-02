import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RoutersService } from './routers.service';
import { CreateRouterDto } from './dto/create-router.dto';

@Controller('routers')
export class RoutersController {
  constructor(private readonly routers: RoutersService) {}

  @Get()
  list(@Query('venueId') venueId?: string) {
    return this.routers.listRouters(venueId);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.routers.getRouterById(id);
  }

  @Post()
  create(@Body() dto: CreateRouterDto) {
    return this.routers.createRouter(dto);
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.routers.testRouter(id);
  }

  @Get(':id/health')
  health(@Param('id') id: string) {
    return this.routers.getHealth(id);
  }

  @Get(':id/provision.rsc')
  getProvisionScript(@Param('id') id: string) {
    return this.routers.generateProvisionScript(id);
  }
}
